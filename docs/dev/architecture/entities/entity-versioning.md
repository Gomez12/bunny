# Entity versioning

## At a glance

One shared `entity_versions` table records JSON snapshots for every first-class entity that opts into versioning via a per-kind `VersionableEntityDef`. Saves are deduplicated on a sha256 content hash and debounced per user; soft-delete and restore drop lifecycle markers (`pre_delete` / `pre_restore`). A small `<HistoryButton>` on each entity opens a per-row modal with the timeline + restore.

Twenty-three kinds are registered today (see [Registered kinds](#registered-kinds)). The legacy `script_versions` chain is preserved and mirrored into `entity_versions` (`source='backfill'`) on the next `openDb()`.

## Where it lives

- `src/memory/versioning.ts` — registry, `recordVersion`, `listVersions`, `getVersion`, `restoreVersion`, `pruneEntityVersions`, `redactKeys`.
- `src/memory/versioning_access.ts` — shared permission helpers (`projectScopedAccess`, `ownerScopedAccess`).
- `src/memory/versioning_prune_handler.ts` — scheduler handler `versioning.prune`.
- `src/memory/trash.ts` — calls `recordVersion(..., 'pre_delete')` / `'pre_restore'` from `softDelete` / `restore`.
- `src/server/versions_routes.ts` — HTTP endpoints, per-kind permission delegation.
- `src/server/index.ts` — registers `VERSIONING_PRUNE_HANDLER` with the scheduler.
- `web/src/components/HistoryButton.tsx` — small icon button + version-count badge dot.
- `web/src/components/EntityHistoryModal.tsx` — sidebar timeline + JSON detail pane + restore confirm.

Each entity memory module (`src/memory/<kind>.ts`) calls `registerVersionable(...)` on import, mirroring `registerTrashable` and `registerKind` in `translatable.ts`.

## Data model

```sql
CREATE TABLE entity_versions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT    NOT NULL,
  entity_id     TEXT    NOT NULL,   -- TEXT so integer + slug ids share one column
  version       INTEGER NOT NULL,
  snapshot_json TEXT    NOT NULL,
  content_hash  TEXT    NOT NULL,   -- sha256 of canonical JSON
  size_bytes    INTEGER NOT NULL,
  source        TEXT    NOT NULL,   -- save | pre_delete | pre_restore | restore | manual | backfill
  flags         TEXT    NOT NULL DEFAULT '',  -- csv: oversized | redacted | partial
  created_at    INTEGER NOT NULL,
  created_by    TEXT,
  UNIQUE(kind, entity_id, version)
);
```

Indexes: `(kind, entity_id, version DESC)` for the per-entity list and `(kind, created_at DESC)` for cross-entity recency queries. Full DDL lives in `src/memory/schema.sql`.

## The registry

```ts
interface VersionableEntityDef {
  kind: VersionableKind;
  table: string;
  primaryKey: string;
  snapshot: (db, id) => Record<string, unknown> | null;
  restore:  (db, id, snapshot) => void;
  sidecars?: readonly string[];
  redact?:  (snapshot) => Record<string, unknown>;
  onMissingReference?: "fail" | "skip" | "reactivate-parent";
  canSee?:  (db, userId, entityId) => boolean;
  canEdit?: (db, userId, entityId) => boolean;
}
```

Public API (re-export from `versioning.ts`):

| Function | Purpose |
| --- | --- |
| `registerVersionable(def)` | Add a kind to the registry (call at import time). |
| `recordVersion(db, kind, id, source, userId)` | Dedup + debounce + insert. Used by routes + trash hooks. |
| `listVersions(db, kind, id)` | Metadata only; no snapshot payload. |
| `getVersion(db, kind, id, version)` | Full snapshot for one version. |
| `restoreVersion(db, kind, id, version, userId)` | Wraps `pre_restore` + `restore` calls. |
| `pruneEntityVersions(db, opts?)` | Apply the keep rules below. |
| `configureVersioning(partial)` | Override defaults at boot or in tests. |
| `redactKeys(snapshot, extraKeys?)` | Helper for kinds with secret-shaped columns. |

## Snapshot lifecycle

```
recordVersion(db, kind, id, source, userId):
  def        = REGISTRY[kind]
  snapshot   = def.snapshot(db, id)
  if def.redact: snapshot = def.redact(snapshot)  -- sets flags='redacted' on diff
  hash       = sha256(canonicalStringify(snapshot))
  if sizeBytes > maxSnapshotBytes:
    payload  = "{}"; flags += "oversized"
  else:
    payload  = JSON.stringify(snapshot)
  BEGIN IMMEDIATE:
    prev = SELECT … WHERE kind = :kind AND entity_id = :id ORDER BY version DESC LIMIT 1
    -- dedup
    if source in ("save", "manual") AND prev.content_hash == hash: skip
    -- debounce
    if source == "save"
       AND prev.created_by == userId
       AND now - prev.created_at < debounceMinutes
       AND prev.source == "save":
      UPDATE prev row (same version)
    else:
      INSERT new row, version = COALESCE(MAX(version), 0) + 1
  COMMIT
```

`pre_delete`, `pre_restore`, `restore`, and `backfill` always insert — they record *when* something happened and must not be collapsed by dedup.

## Mutation hooks

- **`src/memory/trash.ts`** — `softDelete(db, kind, id, userId)` records `pre_delete` BEFORE the rename + sidecar drop, so the snapshot still has the canonical name and a populated translation list. `restore(db, kind, id)` records `pre_restore` AFTER the existence + name-conflict checks but BEFORE the rename + reseed; the snapshot captures the trashed/mangled state-being-replaced. `restore` does not take a user argument, so `pre_restore` rows are stored with `created_by = null`. Both hooks are guarded by `getVersionableDef(kind)`; unregistered kinds stay no-ops.
- **`src/server/*_routes.ts`** — every user-driven create/update/save endpoint calls `recordVersion(db, kind, id, "save", user.id)` after a successful mutation. Worker-driven writes (transcription completion, soul refresh, business auto-build, address auto-fill, web-news fetches) are intentionally not hooked — they would flood the chain with bot edits and clutter the audit trail.

## Registered kinds

Twenty-three kinds via `registerVersionable` (one per row's memory module):

```
agent, board_card, board_swimlane, business, code_project,
contact, contact_group, diagram, diary_entry, document,
kb_definition, planning_deadline, planning_project,
planning_suggestion, planning_tag, planning_team, planning_wish,
scheduled_task, script, skill, web_news_topic, whiteboard,
workflow
```

Out of scope:

- `planning_report` — insert-only artefact, no update path.
- Hard-deleted operational rows (sessions, message turns, events) — those remain in the message / event log.

`project` is reserved in `VersionableKind` but no kind has been registered yet (projects act as the scope for everything else; restoring one would cascade into 22 other kinds).

## HTTP API

```
GET    /api/versions/:kind/:entityId            → { versions: VersionMeta[] }
GET    /api/versions/:kind/:entityId/count      → { count }   (badge dot)
GET    /api/versions/:kind/:entityId/:version   → { version: VersionDetail }
POST   /api/versions/:kind/:entityId/restore    → body { version }
```

Admins always bypass. Non-admins go through the kind's optional `canSee` / `canEdit` callbacks. A missing callback denies, so kinds opt into non-admin access incrementally.

Four policies are in use today (`src/memory/versioning_access.ts` for the first two; visibility-based and admin-only are inline):

| Policy | Used by | `canSee` | `canEdit` |
| --- | --- | --- | --- |
| **project-scoped** (`projectScopedAccess`) | documents, whiteboards, diary entries, kb_definitions, contacts, businesses, board cards, board_swimlanes, code projects, workflows, diagrams, scripts, web_news_topic, contact_groups, all five `planning_*` kinds | project is public OR user is creator | user is project creator |
| **owner-scoped** (`ownerScopedAccess`) | scheduled_task | row's `owner_user_id == userId` (system tasks `owner_user_id IS NULL` stay admin-only) | same |
| **visibility-based** (inline) | agent, skill | `visibility = 'public'` OR `created_by = userId` | `created_by = userId` |
| **admin-only** (default fallback) | planning_suggestion | — | — |

## Secret redaction

`SECRET_COLUMN_PATTERN` (`/secret|token|api[_-]?key|password|webhook/i`) matches column names in the snapshot. The lint test `tests/memory/versioning-redaction.test.ts` fails if a registered kind has matching columns without declaring `redact`. None of the currently registered kinds carry secret-shaped columns, so no kind has `redact` set in production.

Drop-in for kinds with secret columns:

```ts
import { redactKeys } from "./versioning.ts";

registerVersionable({
  kind: "integration",
  // …
  redact: (snapshot) => redactKeys(snapshot),  // masks strings, nulls others
});
```

## Pruning

`pruneEntityVersions(db, { maxSavePerEntity })` keeps:

1. `version = 1` — origin row.
2. Every lifecycle marker (`pre_delete`, `pre_restore`, `restore`, `manual`, `backfill`).
3. The most recent N `save` rows per `(kind, entity_id)`. Default `N = 200` from `VersioningConfig.maxVersionsPerEntity`. Set to `0` to disable pruning.

Wired to the scheduler as `versioning.prune` (seeded in `src/server/index.ts`).

## Configuration

`VersioningConfig` lives as in-process state with sensible defaults:

```ts
const DEFAULT_CONFIG: VersioningConfig = {
  debounceMinutes: 5,
  maxSnapshotBytes: 1_048_576,
  maxVersionsPerEntity: 200,
};
```

Override via `configureVersioning({ … })`. Tests use this to set `debounceMinutes: 0` for predictability. Operator tunability via a `[versioning]` block in `bunny.config.toml` is captured as a follow-up in [`../../follow-ups/versioning-config-loader.md`](../../follow-ups/versioning-config-loader.md).

## UI

`<HistoryButton kind={…} entityId={…} entityName={…} onRestored={…} />`:

- Lucide `History` icon (14 px), `aria-label="Show version history"`, `aria-haspopup="dialog"`.
- Fetches `/api/versions/:kind/:id/count` once on mount; renders a subtle dot when `count > 0`.
- Click opens `<EntityHistoryModal>`.

`<EntityHistoryModal>` wraps `<Modal size="md">`:

- Sidebar lists versions (newest first) with version number, relative time, source label, and any flags.
- Detail pane shows pretty-printed JSON. Per-kind renderers are an explicit follow-up; the JSON fallback was the v1 trade-off.
- Restore goes through `<ConfirmDialog>`; the server captures `pre_restore` before applying.
- Focus returns to the originating `HistoryButton` on close (Modal's existing behaviour).

The legacy `ScriptVersionsView` keeps working unchanged. Script rows also gain the generic `<HistoryButton>` for consistency.

## Backfill from `script_versions`

A one-time migration inside `openDb()` mirrors every legacy `script_versions` row into `entity_versions` with `kind='script'` and `source='backfill'`. The migration uses `INSERT OR IGNORE` keyed on `UNIQUE(kind, entity_id, version)`, so it is idempotent. The legacy table and `ScriptVersionsView` are intentionally not removed.

## Key invariants

- **One transaction per write.** `recordVersion` runs inside `BEGIN IMMEDIATE`; the `MAX(version) + 1` read and the INSERT happen atomically. Without this, two concurrent saves can both compute the same next version and the second loses to a UNIQUE violation.
- **Worker writes stay out of the chain.** Only user-initiated routes call `recordVersion`. Background handlers (translation, business auto-build, web-news fetch) are silent.
- **`entity_id` is always `TEXT`.** Callers pass `String(id)` even when the row uses an integer primary key.
- **Snapshots include sidecars.** A kind's `snapshot` callback must pull sidecar data (translations, exceptions) so restore can round-trip. `sidecars` on the def is documentary.
- **Restore is UPDATE, never INSERT.** The row must still exist. To restore a soft-deleted row, restore it from trash first, then restore its version.

## Gotchas

- Restore that references a soft-deleted parent currently fails with `VERSION_RESTORE_MISSING_REF` (default `onMissingReference: "fail"`). No registered kind uses `"skip"` or `"reactivate-parent"` yet; that path lights up only when needed.
- The `oversized` flag indicates the payload was dropped to `{}` but the hash is still computed over the full original payload, so two distinct oversized snapshots don't collapse to the same row.
- `redactKeys` masks strings to `"[REDACTED]"` and replaces other types with `null`. Tune via the `extraKeys` arg if you need to redact non-pattern columns.

## Related

- [ADR 0046 — Universal entity versioning](../../decisions/0046-entity-versioning.md).
- [`../soft-delete-and-trash.md`](../soft-delete-and-trash.md) — `pre_delete` / `pre_restore` hook ordering.
- [ADR 0037 — Scripts subsystem](../../decisions/0037-scripts-subsystem.md) — legacy `script_versions`.
- Plan: [`../../plans/entity-revision-history.md`](../../plans/entity-revision-history.md).
- Risks: [`../../risks/entity-versioning-storage.md`](../../risks/entity-versioning-storage.md), [`../../risks/entity-versioning-migration.md`](../../risks/entity-versioning-migration.md).
- User guide: [`../../../user/features/entity-history.md`](../../../user/features/entity-history.md).
