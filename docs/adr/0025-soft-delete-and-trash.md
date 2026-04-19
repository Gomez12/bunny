# ADR 0025 — Soft-delete and trash bin

**Status:** Accepted
**Date:** 2026-04-18

## Context

The DELETE buttons on Documents, Whiteboards, Contacts, and Knowledge-Base
Definitions were hard DELETEs: the row vanished and any translations cascaded
with it. Users asked for a safety net — "delete" from their point of view,
but recoverable by an admin. A single, entity-agnostic **Trash** surface was
preferred over four bespoke "hidden items" UIs.

The four in-scope entities were chosen deliberately. Board cards already have
an `archived_at` flow and a dedicated Archive UI; they stay out of scope.
Projects, agents, skills, and scheduler tasks are structural — their DELETE
operations feed cascade semantics we do not want to weaken. Sessions carry
per-user visibility instead; soft-deleting a session would mean teaching
`messages` to follow.

## Decision

### Two new columns per entity, no new tables

Every in-scope entity gets `deleted_at INTEGER` and `deleted_by TEXT`. Both
are nullable; a non-null `deleted_at` is the sole soft-delete flag. The
columns are added through `migrateColumns` in `src/memory/db.ts` — the schema
is append-only as policy (CLAUDE.md) so the four `ALTER TABLE`s coexist with
the canonical `schema.sql` definitions.

Dashboards, translation scheduler handlers, and recall/search already route
through the typed memory helpers (`getDocument`, `listContacts`, …), which
now carry `AND deleted_at IS NULL`. A grep audit
(`FROM (documents|whiteboards|contacts|kb_definitions)\b`) verifies that no
raw SQL elsewhere bypasses the filter.

### Rename-on-soft-delete to free `UNIQUE(project, name|term)`

Three of the four tables (`documents`, `whiteboards`, `kb_definitions`) carry
a table-level `UNIQUE(project, name)` or `UNIQUE(project, term)`. A table
constraint creates a full implicit unique index — a partial
`CREATE UNIQUE INDEX … WHERE deleted_at IS NULL` cannot weaken it, and
dropping the constraint is forbidden by the append-only schema policy.

Instead, on soft-delete we rename the display column to
`__trash:<id>:<original>` inside the same transaction. This is always unique
(the prefix carries the primary key) so UNIQUE stays happy and the user can
re-create "Plan" immediately after deletion. On restore we strip the prefix
and try to put the original name back; if another live row has already
taken it, we return `409 name_conflict` and let the admin rename the
conflicting item or hard-delete this one.

`kb_definitions.term COLLATE NOCASE` is unaffected — the ASCII prefix plus
the autoincrement id guarantee no case-insensitive collision.

### Translation sidecars dropped on soft-delete, reseeded on restore

`translatable.claimPending` selects pending sidecar rows without looking at
the entity table. Left alone, the scheduler would keep claiming rows for
ghosts and either translate phantom content or crash-loop with `setError`.
Two solutions presented themselves:

1. Make `translatable.ts` trash-aware (add an optional `deletedColumn` field
   to `TranslatableKind`, filter in `getEntitySource` and `claimPending`).
2. Drop the sidecar rows on soft-delete and reseed them on restore.

We picked option 2. It keeps `translatable.ts` ignorant of the trash layer,
is a single `DELETE FROM sidecar WHERE fk = ?` in the soft-delete
transaction, and on restore the source may have changed externally anyway so
a fresh translation pass is the right default. The cached `source_hash`
short-circuit is cheap enough that losing it costs nothing practical. The
only surprise is that restore re-runs the LLM for every non-source language;
we accept that.

### One registry module, one HTTP surface

`src/memory/trash.ts` exposes:

```ts
interface TrashEntityDef {
  kind: "document" | "whiteboard" | "contact" | "kb_definition";
  table: string;
  nameColumn: "name" | "term";
  hasUniqueName: boolean;
  translationSidecarTable: string | null;
  translationSidecarFk: string | null;
  reseedTranslations?: (db, id) => void;
}

export function registerTrashable(def: TrashEntityDef): void;
export function softDelete(db, def, id, userId): boolean;
export function restore(db, def, id): "ok" | "not_found" | "name_conflict";
export function hardDelete(db, def, id): boolean;
export function listTrash(db): TrashItem[];
```

Each entity module calls `registerTrashable({...})` on import, mirroring
`registerKind` in `translatable.ts`. The HTTP layer
(`src/server/trash_routes.ts`) never names a specific table; a fifth
trashable entity is a `registerTrashable(...)` call plus two new columns.

### Admin-only, mounted before generic project routes

Three endpoints, all gated by `user.role === 'admin'` up-front:

- `GET /api/trash` — unified list across every registered kind, newest-first.
- `POST /api/trash/:kind/:id/restore` — 200 / 404 / 409 / 400.
- `DELETE /api/trash/:kind/:id` — hard delete; refuses when the row is live.

Routes are mounted between the scheduled-task and `/api/config/ui` routes in
`handleApi` so the single ACL check runs before every other trash path match.

### Frontend: sub-tab under Settings (admin-only)

`SettingsPage` gains a fifth sub-tab **Trash** that lazy-loads
`web/src/tabs/TrashTab.tsx`. The tab is a simple table: kind pill, display
name (prefix stripped), project, deleted-at, deleted-by, and two actions
per row — *Restore* and *Delete forever*. A `name_conflict` response
surfaces as a targeted `alert()` explaining which project still holds the
name. No cross-tab broadcast exists yet; the page reloads on mount and on
each mutation. The existing DELETE buttons on Documents / Whiteboards /
Contacts / Definitions keep their UX unchanged: the item disappears from the
user's list, and the trash row is now available to admins.

## Consequences

- **Storage growth is real.** Soft-deleted rows accumulate until an admin
  empties the bin. For the v1 cadence this is fine; a future scheduled-task
  `trash.auto_purge` (e.g. hard-delete rows older than 90 days) is a
  one-registration addition.
- **Restore re-triggers translation.** Users who hit restore and immediately
  expect their old translations back should know the scheduler needs a few
  minutes. Acceptable — the alternative of preserving stale sidecars risked
  serving outdated translations once the source had been edited elsewhere.
- **Queue telemetry gains a new topic.** `topic: "trash"` logs both
  `restore` and `hard_delete`. The existing `document.delete` /
  `whiteboard.delete` / `contact.delete` / `kb.definition.delete` events now
  carry `soft: true` in their `data` so the Logs tab can tell the two kinds
  of "delete" apart at a glance.
- **Queries must stay filtered.** Every existing `FROM <table>` in the
  memory helpers now carries `deleted_at IS NULL`. New queries must follow
  suit; the mangled `__trash:` names make missing filters impossible to miss
  in the UI (a leaking name is the canary) but the grep audit
  `FROM (documents|whiteboards|contacts|kb_definitions)\b` is the hard
  gate.

## Alternatives considered

- **Sentinel prefixes only on `UNIQUE` tables, tombstone rows elsewhere.**
  Asymmetric, two mental models in one module.
- **Per-entity Archive UIs.** Four copies of the same screen and no way to
  do cross-entity "empty everything older than 30 days" in one place later.
- **Cascade the soft-delete to translations (mark sidecars pending with a
  tombstone flag).** More columns, more state, more tests, no upside —
  restored entities should re-translate anyway.
- **Delete-by-rename only, no `deleted_at` column.** Loses audit info
  (who + when) and makes the bin list require table scans for `LIKE
  '__trash:%'` instead of an indexable predicate.

## Related

- ADR 0022 — Multi-language translation (source of `TranslatableKind` pattern).
- ADR 0011 — Scheduled tasks (candidate host for a future `trash.auto_purge`).
