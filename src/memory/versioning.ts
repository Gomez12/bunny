/**
 * Universal entity versioning — registry, snapshot writer, restore.
 *
 * Every "first-class" entity in the database can opt into versioning by calling
 * `registerVersionable(...)` from its memory module (mirroring the trash and
 * translatable registries). The shared `entity_versions` table stores one JSON
 * snapshot per save event after dedup + per-user debounce.
 *
 * Design notes:
 *
 * - **One central table.** `entity_versions(kind, entity_id, version, …)` —
 *   trades a tiny serialisation cost for uniform query shapes across 25+ kinds.
 *   We can move a hot kind to its own table later if profiling demands it; the
 *   contract is `recordVersion / listVersions / restoreVersion`.
 *
 * - **`entity_id TEXT`.** Bunny mixes integer ids (`scripts`, `documents`) with
 *   slug ids (`projects.name`, `agents.id`). One TEXT column avoids two parallel
 *   indexes; callers pass `String(id)`.
 *
 * - **Dedup + debounce.** A `recordVersion('save', …)` call inside the
 *   `debounce_minutes` window for the same `(kind, entity_id, user)` overwrites
 *   the previous row rather than appending. `pre_delete` / `pre_restore` /
 *   `manual` always append. Identical `content_hash` always skips.
 *
 * - **Race safety.** All writes run inside `BEGIN IMMEDIATE` so the
 *   `max(version)+1` read and the INSERT happen atomically; without this, two
 *   concurrent saves can both compute the same next version and the second
 *   loses to a UNIQUE violation.
 *
 * - **Secret redaction.** `VersionableEntityDef.redact` lets a kind strip
 *   secret-shaped columns before they hit the snapshot. The companion lint test
 *   (`tests/memory/versioning-redaction.test.ts`) fails if a registered kind
 *   has columns matching /secret|token|api[_-]?key|password|webhook/i without
 *   declaring `redact`.
 *
 * See `docs/dev/plans/entity-revision-history.md` and ADR 0046.
 */

import type { Database } from "bun:sqlite";

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * Kinds known to the versioning system. Concrete strings are added here when
 * the matching entity module calls `registerVersionable(...)`. The literal
 * union keeps `recordVersion("typoo", ...)` a type error at the call site.
 */
export type VersionableKind =
  | "document"
  | "whiteboard"
  | "contact"
  | "kb_definition"
  | "code_project"
  | "workflow"
  | "business"
  | "script"
  | "diagram"
  | "diary_entry"
  | "planning_project"
  | "planning_deadline"
  | "planning_team"
  | "planning_tag"
  | "planning_wish"
  | "project"
  | "agent"
  | "skill"
  | "board_card"
  | "board_swimlane"
  | "planning_suggestion"
  | "planning_report"
  | "scheduled_task"
  | "web_news_topic"
  | "contact_group"
  // Reserved for tests so they can register a throw-away kind without
  // polluting the production union. See tests/memory/versioning*.test.ts.
  | "__test__";

/** Why a version row exists. Independent of {@link VersionFlag}. */
export type VersionSource =
  | "save"
  | "pre_delete"
  | "pre_restore"
  | "restore"
  | "manual"
  | "backfill";

/**
 * Independent markers stored as a CSV in the `flags` column. Multiple flags
 * may be set on one row (e.g. `'redacted,partial'`).
 */
export type VersionFlag = "oversized" | "redacted" | "partial";

/**
 * Policy when a restored snapshot references entities that no longer exist
 * (FK target soft-deleted, parent removed, etc).
 *
 * - `"fail"` (default) — abort the restore inside the transaction with a
 *   `VERSION_RESTORE_MISSING_REF` error. Caller surfaces the missing refs.
 * - `"skip"` — clear the dangling reference (set to NULL where the column
 *   allows it) and continue. The entity is restored but disconnected.
 * - `"reactivate-parent"` — un-soft-delete the parent so the reference
 *   resolves. Only safe for kinds where this is reversible and expected.
 */
export type MissingRefPolicy = "fail" | "skip" | "reactivate-parent";

export interface VersionableEntityDef {
  readonly kind: VersionableKind;
  /** The base table whose row this kind versions. */
  readonly table: string;
  /** Primary-key column on `table`. Usually `"id"`; may be `"name"` for projects. */
  readonly primaryKey: string;
  /**
   * Pluck the canonical representation of one entity from the DB.
   *
   * Should include sidecar data (translations, exceptions, …) that must round-
   * trip through restore. Return `null` when the row no longer exists.
   *
   * Implementations must not include columns that store secrets — use
   * {@link VersionableEntityDef.redact} for that.
   */
  snapshot: (db: Database, id: string) => Record<string, unknown> | null;
  /**
   * Apply a snapshot back to the entity. The row identified by `id` must
   * already exist (restore is an UPDATE, never an INSERT). Implementations
   * run inside the caller's transaction and may throw to abort.
   */
  restore: (
    db: Database,
    id: string,
    snapshot: Record<string, unknown>,
  ) => void;
  /** Sidecar tables that participate in `snapshot` — purely documentary. */
  readonly sidecars?: readonly string[];
  /**
   * Optional redaction step applied to the snapshot before hashing/storing.
   * Required when `table` has secret-shaped columns (see lint test).
   */
  redact?: (snapshot: Record<string, unknown>) => Record<string, unknown>;
  /** Restore policy when references are missing. Defaults to `"fail"`. */
  readonly onMissingReference?: MissingRefPolicy;
  /**
   * Optional permission delegate. Admins always bypass; for non-admin users
   * the route layer calls these to decide whether the user can list/read the
   * entity's version chain (`canSee`) or trigger a restore (`canEdit`).
   *
   * Kept as plain `(db, userId, entityId) => boolean` so this module doesn't
   * have to import the `User` shape from the auth subsystem — the route hands
   * over the role itself and only invokes the callback when the user is
   * non-admin. Returning `false` (or leaving the callback undefined) keeps
   * the endpoint admin-only for that kind.
   */
  readonly canSee?: (db: Database, userId: string, entityId: string) => boolean;
  readonly canEdit?: (db: Database, userId: string, entityId: string) => boolean;
}

/** Lightweight metadata returned by `listVersions` — never includes `snapshot_json`. */
export interface VersionMeta {
  readonly id: number;
  readonly kind: VersionableKind;
  readonly entityId: string;
  readonly version: number;
  readonly contentHash: string;
  readonly sizeBytes: number;
  readonly source: VersionSource;
  readonly flags: readonly VersionFlag[];
  readonly createdAt: number;
  readonly createdBy: string | null;
}

/** Full version row including the snapshot payload. */
export interface VersionDetail extends VersionMeta {
  readonly snapshot: Record<string, unknown> | null;
}

export interface VersioningConfig {
  /** Window in which a same-user `'save'` call overwrites instead of appending. */
  debounceMinutes: number;
  /** Snapshots larger than this skip storage; the row is still recorded with `flags='oversized'`. */
  maxSnapshotBytes: number;
  /**
   * Per (kind, entity_id) cap on stored `save` rows. Lifecycle markers
   * (`pre_delete` / `pre_restore` / `restore` / `manual` / `backfill`) and
   * `version = 1` never count against this cap — those are always kept by
   * `pruneEntityVersions`. Set to `0` to disable pruning entirely.
   */
  maxVersionsPerEntity: number;
}

const DEFAULT_CONFIG: VersioningConfig = {
  debounceMinutes: 5,
  maxSnapshotBytes: 1_048_576,
  maxVersionsPerEntity: 200,
};

let CONFIG: VersioningConfig = { ...DEFAULT_CONFIG };

/** Override defaults at app boot. Test helper too. */
export function configureVersioning(partial: Partial<VersioningConfig>): void {
  CONFIG = { ...CONFIG, ...partial };
}

/** Read-only view; mainly useful in tests. */
export function getVersioningConfig(): VersioningConfig {
  return { ...CONFIG };
}

// ── Registry ─────────────────────────────────────────────────────────────────

const REGISTRY: Map<VersionableKind, VersionableEntityDef> = new Map();

export function registerVersionable(def: VersionableEntityDef): void {
  REGISTRY.set(def.kind, def);
}

export function getVersionableDef(
  kind: string,
): VersionableEntityDef | undefined {
  return REGISTRY.get(kind as VersionableKind);
}

export function listVersionableKinds(): VersionableEntityDef[] {
  return [...REGISTRY.values()];
}

/** Test-only: drop a kind from the registry. Production code never calls this. */
export function unregisterVersionable(kind: VersionableKind): void {
  REGISTRY.delete(kind);
}

function requireDef(kind: VersionableKind): VersionableEntityDef {
  const def = REGISTRY.get(kind);
  if (!def) throw new Error(`unknown versionable kind: ${kind}`);
  return def;
}

// ── Hashing + canonical serialisation ────────────────────────────────────────

/**
 * Deterministic JSON serialisation — keys sorted at every nesting level so two
 * objects with identical content always hash the same regardless of insertion
 * order. Arrays preserve their order (that's part of the value).
 */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map((v) => canonicalStringify(v)).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const k of keys) {
    parts.push(JSON.stringify(k) + ":" + canonicalStringify(obj[k]));
  }
  return "{" + parts.join(",") + "}";
}

function sha256(s: string): string {
  return new Bun.CryptoHasher("sha256").update(s).digest("hex");
}

function parseFlags(csv: string): VersionFlag[] {
  if (!csv) return [];
  const out: VersionFlag[] = [];
  for (const p of csv.split(",")) {
    const t = p.trim();
    if (t === "oversized" || t === "redacted" || t === "partial") out.push(t);
  }
  return out;
}

function stringifyFlags(flags: readonly VersionFlag[]): string {
  return flags.length === 0 ? "" : flags.join(",");
}

// ── Snapshot writer ──────────────────────────────────────────────────────────

export interface RecordVersionResult {
  /** What happened. `"skipped"` means the snapshot was identical to the previous version. */
  readonly outcome: "inserted" | "debounced" | "skipped" | "missing";
  /** Row id of the affected version (only set on `inserted`/`debounced`). */
  readonly versionId: number | null;
  /** 1-based version number (only set on `inserted`/`debounced`). */
  readonly version: number | null;
}

interface PreparedSnapshot {
  readonly snapshotJson: string;
  readonly contentHash: string;
  readonly sizeBytes: number;
  readonly flags: readonly VersionFlag[];
}

/**
 * Apply redaction, hash the *pre-truncation* payload (so two different
 * oversized payloads stay distinguishable), then drop the payload to `'{}'`
 * when it exceeds the size cap. Shared by all snapshot writers to keep the
 * dedup contract identical.
 */
function prepareSnapshot(
  def: VersionableEntityDef,
  raw: Record<string, unknown>,
): PreparedSnapshot {
  const flags: VersionFlag[] = [];
  let payload: Record<string, unknown> = raw;
  if (def.redact) {
    const redacted = def.redact(raw);
    if (canonicalStringify(redacted) !== canonicalStringify(raw)) {
      flags.push("redacted");
    }
    payload = redacted;
  }
  const fullJson = canonicalStringify(payload);
  const sizeBytes = Buffer.byteLength(fullJson, "utf8");
  // Hash the full payload — never the truncated stub. Otherwise every
  // oversized snapshot collides on sha256("{}") and the dedup short-circuit
  // would silently drop legitimate new versions on the floor.
  const contentHash = sha256(fullJson);
  let snapshotJson = fullJson;
  if (sizeBytes > CONFIG.maxSnapshotBytes) {
    flags.push("oversized");
    snapshotJson = "{}";
  }
  return { snapshotJson, contentHash, sizeBytes, flags };
}

/**
 * Snapshot-and-insert without opening its own transaction. Use this when the
 * caller already holds an open `db.transaction(...)` — SQLite cannot `BEGIN`
 * inside a `BEGIN`. Mutation routes that update the main row plus sidecars in
 * one transaction call this; everything else uses {@link recordVersion}.
 */
export function recordVersionInTx(
  db: Database,
  kind: VersionableKind,
  entityId: string | number,
  source: VersionSource,
  userId: string | null,
): RecordVersionResult {
  const def = requireDef(kind);
  const id = String(entityId);
  const raw = def.snapshot(db, id);
  if (!raw) return { outcome: "missing", versionId: null, version: null };

  const prepared = prepareSnapshot(def, raw);
  const flagsCsv = stringifyFlags(prepared.flags);
  const now = Date.now();
  const debounceMs = CONFIG.debounceMinutes * 60_000;

  const prev = db
    .prepare(
      `SELECT id, version, content_hash, source, created_by, created_at
         FROM entity_versions
        WHERE kind = ? AND entity_id = ?
        ORDER BY version DESC
        LIMIT 1`,
    )
    .get(kind, id) as {
    id: number;
    version: number;
    content_hash: string;
    source: string;
    created_by: string | null;
    created_at: number;
  } | null;

  // Dedup applies only to user-driven saves. Lifecycle markers
  // (pre_delete / pre_restore / restore / backfill) must always materialise
  // so the version chain records *when* the event happened, even when content
  // matched the previous row.
  const dedupEligible = source === "save" || source === "manual";
  if (dedupEligible && prev && prev.content_hash === prepared.contentHash) {
    return { outcome: "skipped", versionId: prev.id, version: prev.version };
  }

  const sameUser = (prev?.created_by ?? null) === (userId ?? null);
  const withinDebounce = prev !== null && now - prev.created_at < debounceMs;
  const canDebounce =
    source === "save" &&
    prev !== null &&
    prev.source === "save" &&
    sameUser &&
    withinDebounce;

  if (canDebounce && prev) {
    db.prepare(
      `UPDATE entity_versions
          SET snapshot_json = ?,
              content_hash  = ?,
              size_bytes    = ?,
              flags         = ?,
              created_at    = ?
        WHERE id = ?`,
    ).run(
      prepared.snapshotJson,
      prepared.contentHash,
      prepared.sizeBytes,
      flagsCsv,
      now,
      prev.id,
    );
    return { outcome: "debounced", versionId: prev.id, version: prev.version };
  }

  const nextVersion = (prev?.version ?? 0) + 1;
  const info = db
    .prepare(
      `INSERT INTO entity_versions
         (kind, entity_id, version, snapshot_json, content_hash,
          size_bytes, source, flags, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      kind,
      id,
      nextVersion,
      prepared.snapshotJson,
      prepared.contentHash,
      prepared.sizeBytes,
      source,
      flagsCsv,
      now,
      userId,
    );
  return {
    outcome: "inserted",
    versionId: Number(info.lastInsertRowid),
    version: nextVersion,
  };
}

/**
 * Take a snapshot of `kind`/`id` and persist it. Opens its own
 * `BEGIN IMMEDIATE` transaction. Call {@link recordVersionInTx} instead when
 * a transaction is already open on this connection — SQLite forbids nested
 * `BEGIN`.
 *
 * The contract (delegated to `recordVersionInTx`):
 *
 * 1. Read latest row for the entity.
 * 2. Compute canonical snapshot + sha256 hash of the full payload. Equal
 *    hash to the previous row → `"skipped"`.
 * 3. Previous row within `debounceMinutes`, same user, both sources `'save'`
 *    → overwrite (`"debounced"`).
 * 4. Otherwise INSERT `version = max(version) + 1` (`"inserted"`).
 *
 * BEGIN IMMEDIATE prevents two writers from both reading the same
 * `max(version)` and both inserting `version = N+1`. SQLite serialises
 * IMMEDIATE writers across the whole DB; `busy_timeout` (set in db.ts)
 * absorbs the wait.
 */
export function recordVersion(
  db: Database,
  kind: VersionableKind,
  entityId: string | number,
  source: VersionSource,
  userId: string | null,
): RecordVersionResult {
  const tx = db.transaction(
    (): RecordVersionResult =>
      recordVersionInTx(db, kind, entityId, source, userId),
  );
  return tx.immediate();
}

// ── Readers ──────────────────────────────────────────────────────────────────

function rowToMeta(r: {
  id: number;
  kind: string;
  entity_id: string;
  version: number;
  content_hash: string;
  size_bytes: number;
  source: string;
  flags: string;
  created_at: number;
  created_by: string | null;
}): VersionMeta {
  return {
    id: r.id,
    kind: r.kind as VersionableKind,
    entityId: r.entity_id,
    version: r.version,
    contentHash: r.content_hash,
    sizeBytes: r.size_bytes,
    source: r.source as VersionSource,
    flags: parseFlags(r.flags),
    createdAt: r.created_at,
    createdBy: r.created_by,
  };
}

export function listVersions(
  db: Database,
  kind: VersionableKind,
  entityId: string | number,
): VersionMeta[] {
  const rows = db
    .prepare(
      `SELECT id, kind, entity_id, version, content_hash, size_bytes,
              source, flags, created_at, created_by
         FROM entity_versions
        WHERE kind = ? AND entity_id = ?
        ORDER BY version DESC`,
    )
    .all(kind, String(entityId)) as Parameters<typeof rowToMeta>[0][];
  return rows.map(rowToMeta);
}

export function countVersions(
  db: Database,
  kind: VersionableKind,
  entityId: string | number,
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM entity_versions WHERE kind = ? AND entity_id = ?`,
    )
    .get(kind, String(entityId)) as { n: number } | undefined;
  return row?.n ?? 0;
}

export function getVersion(
  db: Database,
  kind: VersionableKind,
  entityId: string | number,
  version: number,
): VersionDetail | null {
  const row = db
    .prepare(
      `SELECT id, kind, entity_id, version, snapshot_json, content_hash,
              size_bytes, source, flags, created_at, created_by
         FROM entity_versions
        WHERE kind = ? AND entity_id = ? AND version = ?`,
    )
    .get(kind, String(entityId), version) as
    | (Parameters<typeof rowToMeta>[0] & { snapshot_json: string })
    | undefined;
  if (!row) return null;
  const meta = rowToMeta(row);
  let snapshot: Record<string, unknown> | null = null;
  if (!meta.flags.includes("oversized")) {
    try {
      const parsed = JSON.parse(row.snapshot_json) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        snapshot = parsed as Record<string, unknown>;
      }
    } catch {
      snapshot = null;
    }
  }
  return { ...meta, snapshot };
}

// ── Restore ──────────────────────────────────────────────────────────────────

/**
 * Restore an entity to the given version. Records a `pre_restore` snapshot
 * first so the action itself is reversible. Throws when the version does not
 * exist or is oversized (and therefore has no payload).
 */
export function restoreVersion(
  db: Database,
  kind: VersionableKind,
  entityId: string | number,
  version: number,
  userId: string | null,
): void {
  const def = requireDef(kind);
  const id = String(entityId);
  const target = getVersion(db, kind, id, version);
  if (!target) {
    throw new Error(`version not found: ${kind}/${id}@${version}`);
  }
  if (target.flags.includes("oversized") || target.snapshot === null) {
    throw new Error(
      `cannot restore oversized snapshot: ${kind}/${id}@${version}`,
    );
  }

  const tx = db.transaction(() => {
    // Capture the current state so the restore is reversible. `pre_restore`
    // is not dedup-eligible, so this row always lands.
    recordVersionInTx(db, kind, id, "pre_restore", userId);
    def.restore(db, id, target.snapshot as Record<string, unknown>);
  });
  tx.immediate();
}

// ── Redaction helpers ────────────────────────────────────────────────────────

/**
 * Pattern shared by the production redact functions and the lint test that
 * enforces redaction on secret-shaped columns. Update both call sites if you
 * widen this — see `tests/memory/versioning-redaction.test.ts`.
 */
export const SECRET_COLUMN_PATTERN =
  /secret|token|api[_-]?key|password|webhook/i;

/**
 * Return a shallow copy of `snapshot` with every key whose name matches
 * {@link SECRET_COLUMN_PATTERN} (or appears in `extraKeys`) replaced by
 * `"[REDACTED]"`. Non-string values become `null` so consumers don't get
 * misleading booleans/numbers masquerading as the literal string.
 */
export function redactKeys(
  snapshot: Record<string, unknown>,
  extraKeys: readonly string[] = [],
): Record<string, unknown> {
  const extras = new Set(extraKeys);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(snapshot)) {
    if (SECRET_COLUMN_PATTERN.test(k) || extras.has(k)) {
      out[k] = typeof v === "string" ? "[REDACTED]" : v === null ? null : null;
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ── Prune ────────────────────────────────────────────────────────────────────

export interface PruneResult {
  /** Number of rows actually deleted. */
  readonly deleted: number;
  /** Distinct (kind, entity_id) tuples touched. */
  readonly entities: number;
}

/**
 * Keep rules (see ADR 0046):
 *
 *   1. `version = 1` is always kept (the origin row).
 *   2. Every lifecycle marker (`pre_delete` / `pre_restore` / `restore` /
 *      `manual` / `backfill`) is always kept — these record *when* something
 *      happened, dropping them silently rewrites history.
 *   3. The most recent `maxSavePerEntity` `save` rows per `(kind, entity_id)`
 *      are kept; older saves get pruned.
 *
 * Pruning runs in a single `BEGIN IMMEDIATE` transaction so a concurrent
 * `recordVersion` either blocks until we finish or sees the post-prune state —
 * never an in-between view where the chain looks shorter than it really is.
 *
 * Returns the total number of deleted rows and how many distinct entities
 * were touched, so a periodic job can log a metric.
 */
export function pruneEntityVersions(
  db: Database,
  opts: { maxSavePerEntity?: number; kind?: VersionableKind } = {},
): PruneResult {
  const cap =
    opts.maxSavePerEntity ?? CONFIG.maxVersionsPerEntity;
  if (cap <= 0) return { deleted: 0, entities: 0 };

  const tx = db.transaction((): PruneResult => {
    // Pick the doomed `save` rows: those that are NOT version 1, that are
    // source='save', and whose newest-first rank within their entity is
    // beyond the cap. ROW_NUMBER() partitions per (kind, entity_id) so the
    // policy is symmetric across entities of any size.
    // Parameter order matches the placeholders in the prepared SQL: the
    // optional `kind` filter is consumed inside the CTE, then `cap` by the
    // outer rn comparison.
    const kindFilter = opts.kind ? "AND kind = ?" : "";
    const params: (string | number)[] = [];
    if (opts.kind) params.push(opts.kind);
    params.push(cap);
    const doomed = db
      .prepare(
        `WITH ranked AS (
           SELECT id, kind, entity_id,
             ROW_NUMBER() OVER (
               PARTITION BY kind, entity_id
               ORDER BY version DESC
             ) AS rn
           FROM entity_versions
           WHERE source = 'save'
             AND version > 1
             ${kindFilter}
         )
         SELECT id, kind, entity_id FROM ranked WHERE rn > ?`,
      )
      .all(...params) as {
      id: number;
      kind: string;
      entity_id: string;
    }[];
    if (doomed.length === 0) return { deleted: 0, entities: 0 };

    const touched = new Set<string>();
    const del = db.prepare(`DELETE FROM entity_versions WHERE id = ?`);
    for (const row of doomed) {
      del.run(row.id);
      touched.add(`${row.kind} ${row.entity_id}`);
    }
    return { deleted: doomed.length, entities: touched.size };
  });
  return tx.immediate();
}
