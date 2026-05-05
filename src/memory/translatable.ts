/**
 * Translatable-entity core.
 *
 * Per-project multi-language support lets every KB definition, document,
 * contact, and board card be authored in one source language and
 * machine-translated into the project's other languages. Four sidecar tables
 * (`kb_definition_translations`, `document_translations`, `contact_translations`,
 * `board_card_translations`) share an identical shape; this module is the
 * single place the shared SQL lives so adding a fifth entity later is a
 * `registerKind(...)` call rather than another round of copy-paste.
 *
 * Staleness uses two coordinates:
 * - entity-level `source_version INTEGER` bumps on every source-field edit —
 *   the cheap "who's stale" filter for the scheduler.
 * - sidecar-level `source_hash TEXT` is sha256(JSON.stringify(sourceFields))
 *   at the moment of translation. Before calling the LLM, the handler
 *   compares hashes and short-circuits edit→revert loops with zero cost.
 *
 * `translating_at` supports the daily stuck-row sweep in
 * `src/translation/sweep_stuck_handler.ts`.
 *
 * See ADR 0022.
 */

import type { Database } from "bun:sqlite";

export type TranslationStatus = "pending" | "translating" | "ready" | "error";

/** Metadata for one translatable entity kind. Shape is uniform; only columns differ. */
export interface TranslatableKind {
  /** Machine name used in SSE events, HTTP paths, and the registry. */
  readonly name:
    | "kb_definition"
    | "document"
    | "contact"
    | "board_card"
    | "business";
  /** Entity table (e.g. 'kb_definitions'). Source copy lives here. */
  readonly entityTable: string;
  /** Sidecar table (e.g. 'kb_definition_translations'). */
  readonly sidecarTable: string;
  /** FK column on the sidecar that references entity.id (e.g. 'definition_id'). */
  readonly entityFk: string;
  /** Snake_case source columns on the entity table that participate in the hash. */
  readonly sourceFields: readonly string[];
  /** Snake_case translated columns on the sidecar — same order as sourceFields. */
  readonly sidecarFields: readonly string[];
  /**
   * Optional SQL predicate that selects "live" rows only — trashed / archived
   * entities are excluded. Used by the backfill pass so a soft-deleted entity
   * never resurrects its sidecars. Example: `"deleted_at IS NULL"` or
   * `"archived_at IS NULL"`. Omit for tables without that notion.
   */
  readonly aliveFilter?: string;
}

/** A row from a sidecar table, normalised for routes and handler use. */
export interface TranslationRow {
  id: number;
  entityId: number;
  lang: string;
  status: TranslationStatus;
  error: string | null;
  sourceVersion: number;
  sourceHash: string | null;
  translatingAt: number | null;
  fields: Record<string, string | null>;
  createdAt: number;
  updatedAt: number;
}

/** Process-wide registry; each kind registers from its own memory module. */
export const TRANSLATABLE_REGISTRY: Record<string, TranslatableKind> = {};

export function registerKind(kind: TranslatableKind): void {
  TRANSLATABLE_REGISTRY[kind.name] = kind;
}

export function getKind(name: string): TranslatableKind | undefined {
  return TRANSLATABLE_REGISTRY[name];
}

export function listKinds(): TranslatableKind[] {
  return Object.values(TRANSLATABLE_REGISTRY);
}

// ── Hashing ─────────────────────────────────────────────────────────────────

/**
 * Deterministic sha256 of the source fields. Keys are sorted so an object with
 * the same values always hashes the same. Values are coerced to strings;
 * `null`/`undefined` become the empty string so "clear a field" is a
 * distinguishable change (different key set vs same keys with blank values).
 */
export function computeSourceHash(fields: Record<string, unknown>): string {
  const keys = Object.keys(fields).sort();
  const normalised: Record<string, string> = {};
  for (const k of keys) {
    const v = fields[k];
    normalised[k] = v === null || v === undefined ? "" : String(v);
  }
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(normalised)).digest("hex");
}

// ── Row mapping ─────────────────────────────────────────────────────────────

function rowToTranslation(
  kind: TranslatableKind,
  r: Record<string, unknown>,
): TranslationRow {
  const fields: Record<string, string | null> = {};
  for (const c of kind.sidecarFields) {
    const v = r[c];
    fields[c] = v === null || v === undefined ? null : String(v);
  }
  const status = r["status"] as string;
  const safeStatus: TranslationStatus =
    status === "pending" ||
    status === "translating" ||
    status === "ready" ||
    status === "error"
      ? status
      : "pending";
  const translatingAtRaw = r["translating_at"];
  return {
    id: Number(r["id"]),
    entityId: Number(r[kind.entityFk]),
    lang: String(r["lang"]),
    status: safeStatus,
    error: (r["error"] as string | null) ?? null,
    sourceVersion: Number(r["source_version"]),
    sourceHash: (r["source_hash"] as string | null) ?? null,
    translatingAt:
      translatingAtRaw === null || translatingAtRaw === undefined
        ? null
        : Number(translatingAtRaw),
    fields,
    createdAt: Number(r["created_at"]),
    updatedAt: Number(r["updated_at"]),
  };
}

function selectCols(kind: TranslatableKind): string {
  const base = [
    "id",
    kind.entityFk,
    "lang",
    "status",
    "error",
    "source_version",
    "source_hash",
    "translating_at",
    "created_at",
    "updated_at",
  ];
  return [...base, ...kind.sidecarFields].join(", ");
}

// ── Source-version + stale marking ──────────────────────────────────────────

/**
 * Called from entity UPDATE routes after a source field change. Bumps the
 * entity's `source_version` and flips every existing sidecar row to
 * `status='pending'` in one transaction. Idempotent.
 */
export function markAllStale(
  db: Database,
  kind: TranslatableKind,
  entityId: number,
): void {
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE ${kind.entityTable} SET source_version = source_version + 1, updated_at = ? WHERE id = ?`,
    ).run(Date.now(), entityId);
    db.prepare(
      `UPDATE ${kind.sidecarTable}
         SET status = 'pending', error = NULL, translating_at = NULL, updated_at = ?
       WHERE ${kind.entityFk} = ?`,
    ).run(Date.now(), entityId);
  });
  tx();
}

/** Read the entity's current `source_version`. Returns null if the row is gone. */
export function getSourceVersion(
  db: Database,
  kind: TranslatableKind,
  entityId: number,
): number | null {
  const row = db
    .prepare(`SELECT source_version FROM ${kind.entityTable} WHERE id = ?`)
    .get(entityId) as { source_version: number } | undefined;
  return row?.source_version ?? null;
}

// ── Listing + ensuring sidecar rows ─────────────────────────────────────────

export function listTranslations(
  db: Database,
  kind: TranslatableKind,
  entityId: number,
): TranslationRow[] {
  const rows = db
    .prepare(
      `SELECT ${selectCols(kind)} FROM ${kind.sidecarTable}
        WHERE ${kind.entityFk} = ?
        ORDER BY lang ASC`,
    )
    .all(entityId) as Record<string, unknown>[];
  return rows.map((r) => rowToTranslation(kind, r));
}

/**
 * Insert a `status='pending'` sidecar row for every project language that is
 * not the entity's `original_lang` and that does not yet have a row. Missing
 * sidecar fields are stored as NULL — the scheduler fills them when it
 * translates. `sourceVersion` is the entity's current version so the handler's
 * freshness check passes only once a first translation lands.
 */
export function ensureLanguageRows(
  db: Database,
  kind: TranslatableKind,
  entityId: number,
  originalLang: string,
  projectLanguages: readonly string[],
  sourceVersion: number,
): void {
  const now = Date.now();
  const sidecarPlaceholders = kind.sidecarFields.map(() => "NULL").join(", ");
  const sidecarCols = kind.sidecarFields.join(", ");
  const stmt = db.prepare(
    `INSERT INTO ${kind.sidecarTable}(${kind.entityFk}, lang, status, source_version, ${sidecarCols}, created_at, updated_at)
     VALUES (?, ?, 'pending', ?, ${sidecarPlaceholders}, ?, ?)
     ON CONFLICT(${kind.entityFk}, lang) DO NOTHING`,
  );
  for (const lang of projectLanguages) {
    if (lang === originalLang) continue;
    stmt.run(entityId, lang, sourceVersion, now, now);
  }
}

// ── Claim / terminal-state setters ──────────────────────────────────────────

/**
 * Atomically claim up to `limit` sidecar rows with `status='pending'` by
 * flipping them to `translating` and stamping `translating_at`. Mirrors the
 * conditional-UPDATE lock on `kb_definitions.llm_status`. Returned rows are a
 * snapshot after the claim so handlers see the new state.
 */
export function claimPending(
  db: Database,
  kind: TranslatableKind,
  limit: number,
  now: number,
): TranslationRow[] {
  const tx = db.transaction(() => {
    const candidates = db
      .prepare(
        `SELECT id FROM ${kind.sidecarTable}
          WHERE status = 'pending'
          ORDER BY updated_at ASC
          LIMIT ?`,
      )
      .all(limit) as { id: number }[];
    if (candidates.length === 0) return [] as TranslationRow[];
    const ids = candidates.map((c) => c.id);
    const placeholders = ids.map(() => "?").join(",");
    db.prepare(
      `UPDATE ${kind.sidecarTable}
          SET status = 'translating', translating_at = ?, error = NULL, updated_at = ?
        WHERE id IN (${placeholders}) AND status = 'pending'`,
    ).run(now, now, ...ids);
    const rows = db
      .prepare(
        `SELECT ${selectCols(kind)} FROM ${kind.sidecarTable}
          WHERE id IN (${placeholders}) AND status = 'translating'`,
      )
      .all(...ids) as Record<string, unknown>[];
    return rows.map((r) => rowToTranslation(kind, r));
  });
  return tx();
}

export function setReady(
  db: Database,
  kind: TranslatableKind,
  sidecarId: number,
  fields: Record<string, string | null>,
  sourceVersion: number,
  sourceHash: string,
): void {
  const assignments = kind.sidecarFields.map((c) => `${c} = ?`).join(", ");
  const values: (string | null)[] = kind.sidecarFields.map(
    (c) => fields[c] ?? null,
  );
  db.prepare(
    `UPDATE ${kind.sidecarTable}
        SET ${assignments},
            status = 'ready', error = NULL, translating_at = NULL,
            source_version = ?, source_hash = ?, updated_at = ?
      WHERE id = ?`,
  ).run(...values, sourceVersion, sourceHash, Date.now(), sidecarId);
}

export function setError(
  db: Database,
  kind: TranslatableKind,
  sidecarId: number,
  error: string,
): void {
  db.prepare(
    `UPDATE ${kind.sidecarTable}
        SET status = 'error', error = ?, translating_at = NULL, updated_at = ?
      WHERE id = ?`,
  ).run(error, Date.now(), sidecarId);
}

/** For hash-skip: hash matched, so just stamp the current source_version. */
export function markReadyNoop(
  db: Database,
  kind: TranslatableKind,
  sidecarId: number,
  sourceVersion: number,
): void {
  db.prepare(
    `UPDATE ${kind.sidecarTable}
        SET status = 'ready', error = NULL, translating_at = NULL,
            source_version = ?, updated_at = ?
      WHERE id = ?`,
  ).run(sourceVersion, Date.now(), sidecarId);
}

// ── Stuck-row sweep (daily) ─────────────────────────────────────────────────

/**
 * Flip any row stuck in `translating` for longer than `thresholdMs` back to
 * `pending`. Caller is the daily `translation.sweep_stuck` task; there is no
 * boot-time sweep so a restart does not silently retry failed runs.
 */
export function sweepStuckTranslating(
  db: Database,
  kind: TranslatableKind,
  thresholdMs: number,
  now: number,
): number {
  const info = db
    .prepare(
      `UPDATE ${kind.sidecarTable}
          SET status = 'pending', translating_at = NULL, updated_at = ?
        WHERE status = 'translating' AND translating_at IS NOT NULL
          AND translating_at < ?`,
    )
    .run(now, now - thresholdMs);
  return info.changes;
}

// ── Fetching entity source fields for hashing + translation ─────────────────

/**
 * Read the source fields (entity columns named in `kind.sourceFields`) plus
 * `source_version`, `original_lang`, and `project`. Returns null if the entity
 * is gone.
 */
export function getEntitySource(
  db: Database,
  kind: TranslatableKind,
  entityId: number,
): {
  project: string;
  originalLang: string | null;
  sourceVersion: number;
  fields: Record<string, string | null>;
} | null {
  const cols = [
    "project",
    "original_lang",
    "source_version",
    ...kind.sourceFields,
  ].join(", ");
  const row = db
    .prepare(`SELECT ${cols} FROM ${kind.entityTable} WHERE id = ?`)
    .get(entityId) as Record<string, unknown> | undefined;
  if (!row) return null;
  const fields: Record<string, string | null> = {};
  for (const c of kind.sourceFields) {
    const v = row[c];
    fields[c] = v === null || v === undefined ? null : String(v);
  }
  return {
    project: String(row["project"]),
    originalLang: (row["original_lang"] as string | null) ?? null,
    sourceVersion: Number(row["source_version"]),
    fields,
  };
}

/** Set the entity's `original_lang`. Used at create time. */
export function setOriginalLang(
  db: Database,
  kind: TranslatableKind,
  entityId: number,
  lang: string,
): void {
  db.prepare(
    `UPDATE ${kind.entityTable} SET original_lang = ?, updated_at = ? WHERE id = ?`,
  ).run(lang, Date.now(), entityId);
}

/**
 * Backfill missing sidecar rows for every live entity of this kind in the
 * given project. Use when the project's `languages` array grows or when a
 * version upgrade lands the translation feature on a database that already
 * has entities. Every call is idempotent — `ensureLanguageRows` uses
 * `ON CONFLICT DO NOTHING`.
 */
export function backfillTranslationSlotsForProject(
  db: Database,
  project: string,
): void {
  const tx = db.transaction(() => {
    for (const kind of listKinds()) {
      const whereAlive = kind.aliveFilter ? ` AND ${kind.aliveFilter}` : "";
      const rows = db
        .prepare(
          `SELECT id FROM ${kind.entityTable} WHERE project = ?${whereAlive}`,
        )
        .all(project) as { id: number }[];
      for (const r of rows) createTranslationSlots(db, kind, r.id);
    }
  });
  tx();
}

/** Backfill missing sidecar rows across every project. Called at boot. */
export function backfillAllTranslationSlots(db: Database): void {
  const projects = db.prepare(`SELECT name FROM projects`).all() as {
    name: string;
  }[];
  for (const p of projects) backfillTranslationSlotsForProject(db, p.name);
}

/**
 * Seed one `status='pending'` sidecar row for every non-source language in
 * the entity's project. Called at entity-create time so the background
 * scheduler has rows to claim. Idempotent.
 */
export function createTranslationSlots(
  db: Database,
  kind: TranslatableKind,
  entityId: number,
): void {
  const row = db
    .prepare(
      `SELECT e.project, e.original_lang, e.source_version,
              p.languages AS languages_json, p.default_language
         FROM ${kind.entityTable} e
         LEFT JOIN projects p ON p.name = e.project
        WHERE e.id = ?`,
    )
    .get(entityId) as
    | {
        project: string;
        original_lang: string | null;
        source_version: number;
        languages_json: string | null;
        default_language: string | null;
      }
    | undefined;
  if (!row) return;
  let projectLanguages: string[];
  try {
    const parsed = row.languages_json ? JSON.parse(row.languages_json) : ["en"];
    projectLanguages = Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string")
      : ["en"];
  } catch {
    projectLanguages = ["en"];
  }
  const originalLang =
    row.original_lang ?? row.default_language ?? projectLanguages[0] ?? "en";
  ensureLanguageRows(
    db,
    kind,
    entityId,
    originalLang,
    projectLanguages,
    row.source_version,
  );
}
