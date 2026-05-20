# ADR 0046 — Universal entity versioning

**Status:** Accepted
**Date:** 2026-05-20

## Context

The scripts subsystem (ADR 0037) introduced its own `script_versions` chain
plus `ScriptVersionsView`, giving users a per-row history with restore. No
other entity in Bunny carries the same affordance. Documents, whiteboards,
diary entries, knowledge-base definitions, contacts, businesses, board cards,
the entire planning module, code projects, workflows, diagrams, agents,
skills, swimlanes, scheduled tasks, web-news topics, contact groups, and
planning suggestions all permit overwrites with no built-in rollback.

A repeat per-entity implementation (per-table version sidecar + dedicated UI)
would mean ~23 parallel chains to maintain and bypass via the trash bin's
soft-delete contract. The trash hook (ADR 0025) already runs at the same
boundary where a snapshot would be useful (`softDelete` / `restore`), but the
trash table only models the live row's death, not its prior states.

## Decision

Introduce one shared `entity_versions` table that every first-class entity
opts into via a per-kind `VersionableEntityDef` (mirroring the
`TrashEntityDef` registry). Saving a row records an append-only JSON snapshot
keyed by `(kind, entity_id, version)`, deduplicated on a sha256 content hash
and debounced inside a configurable per-user window. A small `<HistoryButton>`
opens a per-entity modal listing the chain and offering restore.

The legacy `script_versions` chain is preserved (its UI relies on a richer
shape than the generic JSON renderer). A one-time backfill on next `openDb()`
mirrors every existing `script_versions` row into `entity_versions` with
`source = 'backfill'` so the new universal History UI sees the full timeline.

## Implementation

### Schema (`src/memory/schema.sql`)

```sql
CREATE TABLE IF NOT EXISTS entity_versions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT    NOT NULL,
  entity_id     TEXT    NOT NULL,   -- TEXT so integer + slug ids share one column
  version       INTEGER NOT NULL,
  snapshot_json TEXT    NOT NULL,
  content_hash  TEXT    NOT NULL,
  size_bytes    INTEGER NOT NULL,
  source        TEXT    NOT NULL,   -- save | pre_delete | pre_restore | restore | manual | backfill
  flags         TEXT    NOT NULL DEFAULT '',  -- csv: oversized | redacted | partial
  created_at    INTEGER NOT NULL,
  created_by    TEXT,
  UNIQUE(kind, entity_id, version)
);
```

Indexes: `(kind, entity_id, version DESC)` for the per-entity list and
`(kind, created_at DESC)` for cross-entity recency queries.

### Registry (`src/memory/versioning.ts`)

```ts
interface VersionableEntityDef {
  kind: VersionableKind;
  table: string;
  primaryKey: string;
  snapshot: (db, id) => Record<string, unknown> | null;
  restore:  (db, id, snapshot) => void;
  sidecars?: readonly string[];                       // documentary only
  redact?:  (snapshot) => Record<string, unknown>;    // mandatory when columns match the secret pattern
  onMissingReference?: "fail" | "skip" | "reactivate-parent";
}
```

`recordVersion(db, kind, id, source, userId)` does the heavy lifting:

1. Pull the canonical snapshot via the kind's `snapshot` callback.
2. Apply `redact` if declared, set `flags='redacted'` when it changes anything.
3. Canonical-stringify (sorted keys) → sha256 → `content_hash`.
4. Drop the payload to `'{}'` and set `flags='oversized'` when it exceeds
   `max_snapshot_bytes`. The hash is still computed over the full payload so
   distinct oversized snapshots don't collapse to the same row.
5. Run inside `BEGIN IMMEDIATE`. Dedup against the previous row by hash for
   `save` / `manual`. Lifecycle markers always materialise. Same-user `save`
   inside the debounce window overwrites the previous row.

### Mutation hooks

- `src/memory/trash.ts` — `softDelete` records `pre_delete` BEFORE rename +
  sidecar drop; `restore` records `pre_restore` AFTER name-conflict check.
  Both guarded by `getVersionableDef(kind)` so unregistered kinds stay no-ops.
- `src/server/*_routes.ts` — each user-driven create/update/save endpoint
  calls `recordVersion(db, kind, id, "save", user.id)` after a successful
  mutation. Worker-driven writes (transcription completion, soul refresh,
  business auto-build, address auto-fill, web-news fetches) are intentionally
  not hooked — they would flood the chain with bot edits and clutter the
  audit trail.

### Registered kinds (23 of ~25 first-class entities)

Document, whiteboard, diary_entry, kb_definition, contact, business,
board_card, planning_project, planning_deadline, planning_team, planning_tag,
planning_wish, code_project, workflow, diagram, script, agent, skill,
board_swimlane, scheduled_task, web_news_topic, contact_group,
planning_suggestion.

Out of scope:
- `planning_report` — insert-only artefact, no update path.
- Hard-deleted operational rows (sessions, message turns, events) — those
  remain in the message / event log.

### HTTP API (`src/server/versions_routes.ts`)

```
GET    /api/versions/:kind/:entityId            → VersionMeta[]
GET    /api/versions/:kind/:entityId/count      → { count } (badge dot)
GET    /api/versions/:kind/:entityId/:version   → VersionDetail
POST   /api/versions/:kind/:entityId/restore    → body { version }
```

The route layer authorises per-kind: admins always bypass; non-admins go
through optional `canSee` / `canEdit` callbacks on the `VersionableEntityDef`.
A missing callback denies, so kinds opt in to non-admin access incrementally.

Implemented policies (`src/memory/versioning_access.ts`):

- **Project-scoped** (`projectScopedAccess`) — used by documents, whiteboards,
  diary entries, kb_definitions, contacts, businesses, board cards,
  board_swimlanes, code projects, workflows, diagrams, scripts, web_news
  topics, contact_groups, and all five planning_* kinds. `canSee` ↔
  `canSeeProject(public OR creator)`; `canEdit` ↔
  `canEditProject(creator)`.
- **Owner-scoped** (`ownerScopedAccess`) — used by `scheduled_task`. Only
  the row's `owner_user_id` may see or restore; system tasks
  (`owner_user_id IS NULL`) stay admin-only.
- **Visibility-based** — agents and skills inline a custom callback:
  `canSee` if `visibility = 'public'` OR `created_by = userId`;
  `canEdit` if `created_by = userId`.
- **Admin-only** (default fallback) — `planning_suggestion` still requires
  admin, since the suggestion row's project name lives on its parent
  planning project (extra hop, deferred follow-up).

### UI (`web/src/components/HistoryButton.tsx`, `EntityHistoryModal.tsx`)

`<HistoryButton kind entityId entityName? onRestored?>` renders a 14 px lucide
`History` icon with a subtle dot when `count > 0`. Click opens
`<EntityHistoryModal>`, a `<Modal size="md">` with a sidebar timeline
(version, time, source, flags) and a JSON-fallback detail pane. Restore goes
through `<ConfirmDialog>`; the server captures a `pre_restore` snapshot
before applying.

Per-kind renderers (e.g. `DocumentVersionRenderer`) are a follow-up — the
JSON fallback keeps the modal useful on day one for every registered kind.

### Pruning

`pruneEntityVersions(db, { maxSavePerEntity })` keeps:

1. `version = 1` (origin).
2. Every lifecycle marker (`pre_delete`, `pre_restore`, `restore`, `manual`,
   `backfill`) — these record *when* something happened.
3. The most recent N `save` rows per `(kind, entity_id)`. Default `N = 200`
   from `VersioningConfig.maxVersionsPerEntity`.

Wired to the scheduler as `versioning.prune`, daily at 04:00.

### `script_versions` backfill

A one-time migration inside `openDb()` mirrors every legacy `script_versions`
row into `entity_versions` with `source='backfill'`. Idempotent — the
`UNIQUE(kind, entity_id, version)` constraint absorbs repeat runs via
`INSERT OR IGNORE`. The legacy `script_versions` table and `ScriptVersionsView`
stay untouched.

### Secret redaction

`SECRET_COLUMN_PATTERN` (`/secret|token|api[_-]?key|password|webhook/i`)
matches column names in the snapshot. The lint test
`tests/memory/versioning-redaction.test.ts` fails if a registered kind has
matching columns without declaring `redact`. `redactKeys(snapshot, extraKeys)`
returns a copy with masked values (`"[REDACTED]"` for strings, `null`
otherwise) — drop in as `redact: (s) => redactKeys(s)` for kinds with secret
columns.

## Consequences

### Positive

- Uniform query shape across every kind: list / count / get / restore.
- Trash + versioning share the lifecycle boundary — `pre_delete` is the
  exact state the user threw away, restorable through the same API.
- Worker writes stay out of the chain by default, so the history is
  readable as a user audit log.
- Backfill from the legacy `script_versions` table preserves history users
  already relied on.

### Negative / risks

- DB growth on heavy-edit kinds (whiteboards with embedded base64 PNGs,
  large code projects). Mitigations: `maxSnapshotBytes` cap with `oversized`
  flag, content-hash dedup, per-kind redaction, daily prune.
- Permission delegation is currently admin-only — non-admin users cannot see
  their own entity history until per-kind `canSee` / `canEdit` callbacks
  are added.
- The plan called for per-kind renderers; v1 ships JSON-only. Acceptable
  trade for shipping the foundation in fewer phases.

### Open questions

- Cross-entity timeline / global History tab — not in scope here. Possible
  follow-up once the per-entity flow proves itself.
- Restoring snapshots that reference soft-deleted parents — `onMissingReference`
  policy is in the registry but no kind currently exercises it. Will need
  audit when the first restore failure surfaces in production.

## References

- Plan: `docs/dev/plans/entity-revision-history.md`
- Trash bin: ADR 0025
- Scripts subsystem (legacy `script_versions`): ADR 0037
- Schema: `src/memory/schema.sql`, `entity_versions` table
- Code: `src/memory/versioning.ts`, `src/server/versions_routes.ts`,
  `web/src/components/HistoryButton.tsx`,
  `web/src/components/EntityHistoryModal.tsx`
