# Plan: Universal Entity Versioning + History UI

**Status:** Completed (2026-05-20). Phases 1–4 shipped under ADR 0046. Current-state reference lives in [`../architecture/entities/entity-versioning.md`](../architecture/entities/entity-versioning.md); the sections below are kept for historical context.

Follow-ups deliberately *not* shipped in v1:

- Per-kind snapshot renderers (JSON fallback ships instead) — see ADR 0046 "Consequences".
- `[versioning]` block in `bunny.config.toml` — [`../follow-ups/versioning-config-loader.md`](../follow-ups/versioning-config-loader.md).
- i18n keys for history UI labels — [`../follow-ups/i18n-entity-history.md`](../follow-ups/i18n-entity-history.md).

Tracked in [`../tasklist.md`](../tasklist.md). See [`AGENTS.md`](../../../AGENTS.md) for the rules.

## Goal

Introduce a single uniform versioning layer for **all** entities in Bunny so users can view and restore previous versions from any entity item, via a small history icon that opens a modal. Generalises the existing `script_versions` + `ScriptVersionsView` pattern into a shared mechanism.

## Scope

- Every entity stored in `db.sqlite`: trashable kinds (15), plus projects, agents, skills, board cards, board swimlanes, planning suggestions, planning reports, and remaining first-class entities.
- Append-only snapshot table (`entity_versions`) keyed by `(kind, entity_id, version)`, storing JSON snapshots.
- Per-`(kind, entity_id, user)` debounced auto-snapshot on every save (~5 min window).
- Per-item small history icon → modal showing version list and restore action.
- Snapshot creation on soft-delete (`pre_delete`) and restore (`pre_restore`).

## Non-goals

- Branching / merging of versions (linear history only).
- Inline diff visualisation in v1 (full snapshot view; diff is a follow-up).
- Cross-entity timeline / global History tab.
- Snapshots for hard-deleted entities (only trashable + main entities).
- Replacing the `events` table — it stays as an operational audit log.

## Approach

### 1. Schema (`src/memory/schema.sql` + `src/memory/db.ts:migrateColumns`)

```sql
CREATE TABLE IF NOT EXISTS entity_versions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT    NOT NULL,
  entity_id       TEXT    NOT NULL,
  version         INTEGER NOT NULL,
  snapshot_json   TEXT    NOT NULL,
  content_hash    TEXT    NOT NULL,
  size_bytes      INTEGER NOT NULL,
  source          TEXT    NOT NULL,  -- 'save' | 'pre_delete' | 'pre_restore' | 'restore' | 'manual' | 'backfill'
  flags           TEXT    NOT NULL DEFAULT '',  -- CSV: 'oversized','redacted','partial'
  created_at      INTEGER NOT NULL,
  created_by      TEXT,
  UNIQUE(kind, entity_id, version)
);
CREATE INDEX IF NOT EXISTS idx_entity_versions_lookup
  ON entity_versions(kind, entity_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_entity_versions_recent
  ON entity_versions(kind, created_at DESC);
```

Append-only DDL; existing `script_versions` table is kept (backwards compatibility). A backfill copies historical script versions into `entity_versions` with `source='backfill'`.

### 2. Registry (`src/memory/versioning.ts` — new)

Analogous to `TrashEntityDef` in `src/memory/trash.ts`:

```ts
export type VersionableKind = TrashKind | "project" | "agent" | "skill"
  | "board_card" | "board_swimlane" | "planning_suggestion" | "planning_report"
  | /* ...remaining... */ ;

export interface VersionableEntityDef {
  kind: VersionableKind;
  table: string;
  primaryKey: string;
  snapshot: (db: Database, id: string) => Record<string, unknown> | null;
  restore: (db: Database, id: string, snapshot: Record<string, unknown>) => void;
  sidecars?: string[];
  redact?: (snapshot: Record<string, unknown>) => Record<string, unknown>;
  onMissingReference?: "fail" | "skip" | "reactivate-parent"; // default "fail"
}
```

Public API:

```ts
registerVersionable(def: VersionableEntityDef): void;
recordVersion(db, kind, id, source, userId): void;   // hash-dedup + debounce
listVersions(db, kind, id): VersionMeta[];
getVersion(db, kind, id, version): VersionDetail | null;
restoreVersion(db, kind, id, version, userId): void;
```

Debounce rule in `recordVersion`:

1. Read latest version for `(kind, entity_id)`.
2. Compute `content_hash` of new snapshot. If equal to previous → skip.
3. If previous `created_at` within `debounce_minutes`, same `created_by`, and `source === 'save'` → overwrite previous row.
4. Otherwise INSERT new row with `version = max(version) + 1`.

All writes happen inside `BEGIN IMMEDIATE` to avoid race conditions on `version`.

### 3. Mutation hooks

- `src/server/*_routes.ts` (37 files): call `recordVersion(...)` after a successful insert/update. Phased per domain cluster.
- `src/memory/trash.ts`:
  - `softDelete()`: call `recordVersion(..., 'pre_delete', userId)` before the deletion.
  - `restore()`: call `recordVersion(..., 'pre_restore', userId)` after restore.

### 4. HTTP API (`src/server/versions_routes.ts` — new)

```
GET    /api/versions/:kind/:entityId               → VersionMeta[]
GET    /api/versions/:kind/:entityId/count         → { count } (used for badge dot)
GET    /api/versions/:kind/:entityId/:version      → { snapshot_json }
POST   /api/versions/:kind/:entityId/restore       → body { version }
```

Permissions reuse the existing per-kind entity read/write checks.

### 5. Config (`bunny.config.toml`)

```toml
[versioning]
debounce_minutes        = 5
max_versions_per_entity = 200
max_snapshot_bytes      = 1048576
prune_interval_hours    = 24
```

Prune always keeps: (a) version 1, (b) most recent 50 versions, (c) every `source='pre_delete'` version, (d) every version with `flags` containing `manual`.

### 6. UI — small icon + modal

Two reusable components for every entity:

**`web/src/components/HistoryButton.tsx`** (new)
- Small icon button (lucide `History`, 14–16 px), styled as `.history-button`.
- Props: `{ kind, entityId, entityName? }`.
- `aria-label="Show version history"`, `aria-haspopup="dialog"`.
- Light dot indicator when ≥1 version exists (fetched via the count endpoint), neutral icon at 0.
- Click → opens `<EntityHistoryModal>`.

**`web/src/components/EntityHistoryModal.tsx`** (new)
- Wraps the existing `Modal` (size `md`). Title: `History — {entityName}`.
- Body = `<EntityHistoryView>` with list+detail layout (sidebar timeline left, snapshot view right), modelled on `ScriptVersionsView` but inside a modal.
- Per-`kind` optional `Renderer`; fallback = pretty-printed JSON in `<pre>`.
- Actions in detail pane: *Restore this version* (confirm step within modal), *Copy as JSON*.
- ESC closes via the existing Modal ESC stack.

Integration: **one icon per entity item**, no SubTabs in dialogs. Placed next to existing per-row action icons in lists, in card headers, in dialog title bars, or in detail-view toolbars.

The existing `ScriptVersionsView` stays as-is. Script rows also gain the `HistoryButton` for consistency.

UI follows existing custom CSS (no shadcn/ui). New classes: `.history-button`, `.history-button--has-versions`, `.entity-history-modal`, `.entity-history-modal__sidebar`, `.entity-history-modal__detail`. Labels inline; i18n deferred (see i18n section).

### 7. Migration / backfill

In `migrateColumns()`:
1. Create `entity_versions` table + indexes.
2. For each registered kind: insert `version=1` row with current snapshot for every existing entity that has no row yet (`source='backfill'`, `created_at = updated_at ?? created_at`).
3. Copy `script_versions` rows into `entity_versions` with `kind='script'`. Mark `script_versions` as deprecated in docs; keep it.

Idempotent: skips entities that already have at least one row in `entity_versions`.

## Affected modules

| Path | Change |
|---|---|
| `src/memory/schema.sql` | New `entity_versions` table + indexes |
| `src/memory/db.ts` | Extend `migrateColumns` with backfill |
| `src/memory/versioning.ts` | **New** — registry, record/restore, debounce |
| `src/memory/trash.ts` | Hook `softDelete`/`restore` into `recordVersion` |
| `src/server/versions_routes.ts` | **New** — list/get/count/restore endpoints |
| `src/server/*_routes.ts` (37×) | Call `recordVersion` after mutations |
| `src/server/app.ts` (router root) | Mount `versions_routes` |
| `web/src/components/HistoryButton.tsx` | **New** — small icon button, opens modal |
| `web/src/components/EntityHistoryModal.tsx` | **New** — modal wrapper |
| `web/src/components/EntityHistoryView.tsx` | **New** — list+detail render component |
| `web/src/components/renderers/*VersionRenderer.tsx` | **New** — per-kind preview renderers (phased; JSON fallback in v1) |
| Entity list/card components (~15–20 files) | Add `<HistoryButton kind entityId />` |
| `web/src/tabs/code/scripts/ScriptVersionsView.tsx` | Keep; scripts row also gets `HistoryButton` |
| `web/src/styles.css` | `.history-button*`, `.entity-history-modal*` classes |
| `bunny.config.toml` (+ loader) | New `[versioning]` section |

## Phases

**Phase 1 — Foundation (no UI impact, ~12h)**
- Schema + `entity_versions` table + indexes
- `src/memory/versioning.ts` registry + `recordVersion` with debounce/hash + transaction strategy
- Per-kind secret-redaction audit + lint test
- Unit tests: dedup, debounce, race-condition, snapshot/restore roundtrip
- Script backfill proof

**Phase 2 — Mutation hooks per domain (~20h, one PR per cluster)**
- 2a: trash.ts pre-delete/pre-restore hooks
- 2b: documents / whiteboards / diary / kb_definitions
- 2c: contacts / businesses / board_cards
- 2d: planning_*
- 2e: code_projects / workflows / diagrams
- 2f: agents / skills / swimlanes (remaining)

**Phase 3 — HTTP API + generic UI (~18h)**
- `versions_routes.ts` + mount, count endpoint for badge dot
- `HistoryButton`, `EntityHistoryModal`, `EntityHistoryView` + styles
- Integration in 2–3 entity lists as proof (documents, projects, scripts row)
- JSON-fallback renderer only

**Phase 4 — Remaining lists + per-kind renderers + prune job (~15h)**
- `HistoryButton` in remaining ~15–20 places
- First 2–3 per-kind renderers (DocumentVersionRenderer, WhiteboardVersionRenderer)
- Scheduled prune job (`max_versions_per_entity`, keep-rules)
- ADR 0046 finalised + architecture doc

Buffer ~10h for sidecar edge cases per kind. Total estimate: **70h**.

## Tests

- `tests/memory/versioning.test.ts` — debounce, hash-dedup, version numbering, pre_delete trigger.
- `tests/memory/versioning-redaction.test.ts` — fails if a registered kind has secret-shaped columns without an explicit `redact`.
- `tests/memory/versioning-race.test.ts` — concurrent `recordVersion` calls do not violate the UNIQUE constraint.
- `tests/memory/versioning-restore.test.ts` — snapshot → restore roundtrip per registered kind.
- `tests/server/versions_routes.test.ts` — list/get/count/restore endpoints + permission checks.
- `tests/memory/trash.test.ts` (existing) — extended: soft-delete creates a `pre_delete` version.
- `tests/web/HistoryButton.test.tsx` — render, badge dot when ≥1 version, opens modal on click.
- `tests/web/EntityHistoryModal.test.tsx` — sidebar render, ESC closes, restore-confirm flow.
- Regression: existing `ScriptVersionsView` keeps working unchanged.

## Docs impact

- `docs/dev/decisions/0046-entity-versioning.md` — new ADR
- `docs/dev/architecture/entities/entity-versioning.md` — architecture doc (registry, snapshot/restore contract, redaction list per kind, sidecar handling)
- `docs/dev/architecture/soft-delete-and-trash.md` — update for `pre_delete` / `pre_restore` interactions
- `docs/user/features/entity-history.md` — end-user guide
- `docs/dev/follow-ups/i18n-entity-history.md` — i18n follow-up record

## i18n impact

None in v1 — follows the current repo-wide convention (inline English labels; no i18n library present). Captured as a follow-up to migrate once a global i18n library lands.

## Accessibility impact

- `HistoryButton`: real `<button>`, `aria-label`, `aria-haspopup="dialog"`, visible focus ring.
- `EntityHistoryModal`: `role="dialog"`, focus trap, ESC closes, focus returns to the originating `HistoryButton` on close.
- Sidebar: `<nav aria-label="Version history">` + `<ul>` of buttons; selected version has `aria-current="true"`. Arrow keys navigate, Enter selects.
- Restore button: `aria-describedby` pointing at the version meta + a confirm step.

## Risks

- **DB growth** — Mitigation: prune, `max_snapshot_bytes`, content-hash dedup, per-kind override. Documented in `docs/dev/risks/entity-versioning-storage.md`.
- **Migration performance** — backfill on large tables (planning, board_cards). Mitigation: batched insert (1000 rows per transaction). Documented in `docs/dev/risks/entity-versioning-migration.md`.
- **Snapshot completeness** — snapshots missing sidecars (translations, exceptions). Mitigation: `sidecars` field + integration test per kind.
- **37 routes touched** — regression risk. Mitigation: phased PRs, smoke test per domain, preserve return shapes.
- **Secrets in snapshots** — keys/tokens captured forever, breaking AGENTS.md "Avoid logging secrets". Mitigation: mandatory `redact` for kinds with secret-shaped columns, enforced by `versioning-redaction.test.ts`.

## Open questions

- Shared entities (agents/skills referenced from multiple projects): global or per-project history? **Proposal**: global, since they exist globally in the DB.
- `pre_delete` snapshot on `hardDelete`? **Proposal**: no — hard delete is an explicit admin action; the version chain remains until pruned.
- Double snapshot on `restore` (pre_restore + restore-result) or single? **Proposal**: only `pre_restore`; any subsequent edit creates a regular `save` version.
