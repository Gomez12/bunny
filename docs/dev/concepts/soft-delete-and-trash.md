# Soft-delete and trash

## At a glance

Four entities can be soft-deleted from the user's UI: **documents**, **whiteboards**, **contacts**, **kb_definitions**. Each carries `deleted_at` + `deleted_by`; a non-null `deleted_at` means the row is in the Trash bin.

Board cards use `archived_at` on their own flow and stay out of scope.

## Where it lives

- `src/memory/trash.ts` — `registerTrashable`, `softDelete`, `restore`, `hardDelete`, `listTrash`.
- Each entity module calls `registerTrashable` on import (same pattern as `registerKind` in `translatable.ts`).
- `src/server/trash_routes.ts` — `GET /api/trash`, `POST /api/trash/:kind/:id/restore`, `DELETE /api/trash/:kind/:id`. Admin-only.
- `web/src/tabs/TrashTab.tsx` — admin-only sub-tab under Settings.

## The central registry

```ts
registerTrashable({
  kind: "document",
  table: "documents",
  nameColumn: "name",
  hasUniqueName: true,
  translationSidecar: "document_translations",
  reseedTranslations: (db, id) => createTranslationSlots(db, "document", id),
});
```

A fifth trashable entity is one `registerTrashable` call plus two new columns (`deleted_at` + `deleted_by`).

## Lifecycle

```
softDelete(kind, id, user):
  UPDATE <table>
  SET deleted_at = :now,
      deleted_by = :user.id,
      <nameColumn> = '__trash:<id>:<name>'   -- only when hasUniqueName
  WHERE id = :id;
  DELETE FROM <translationSidecar> WHERE <entity>_id = :id;

restore(kind, id):
  -- check that stripping __trash: prefix doesn't collide with a live row
  UPDATE <table>
  SET deleted_at = NULL,
      deleted_by = NULL,
      <nameColumn> = <stripped>
  WHERE id = :id;
  reseedTranslations(db, id);   -- re-seeds pending sidecars

hardDelete(kind, id):
  DELETE FROM <table> WHERE id = :id;
  -- FK ON DELETE CASCADE drops translation rows
```

## Why name-munging

`UNIQUE(project, name)` constraints can't be weakened without breaking the live data model. So soft-delete renames the row to `__trash:<id>:<original>` inside the same transaction. Every list/get query filters `AND deleted_at IS NULL`, so users never see the mangled name. Restore strips the prefix; if another live row already uses the original name, restore returns `name_conflict` (HTTP 409) so the admin can resolve it.

## Translation sidecars on trash/restore

- **Soft-delete drops sidecars.** This keeps `translatable.ts` ignorant of trash and avoids the scheduler chasing ghost entities.
- **Restore reseeds sidecars.** The `reseedTranslations` callback calls `createTranslationSlots`. Translations are re-run because the source may have drifted.

## List/get audit

Every list/get query must carry `AND deleted_at IS NULL`. The grep:

```sh
rg 'FROM (documents|whiteboards|contacts|kb_definitions)\b' src/
```

should return zero hits without the predicate. A mangled `__trash:` name leaking into the UI is the canary that a query was added without the filter.

## Existing DELETE endpoints

The user-visible delete endpoints (`DELETE /api/whiteboards/:id`, etc.) continue to work and now call `softDelete`. Queue logs get `soft: true` in the payload so the audit trail distinguishes soft from hard.

## Key invariants

- **Name-munging is inside the transaction.** The rename and the `deleted_at` bump happen atomically so there's never a window where two live rows collide.
- **Every list/get filters `deleted_at IS NULL`.** No exceptions.
- **Board cards are out of scope.** They use `archived_at` which behaves differently (no unique-name conflict, no translation sidecar reseed). Don't try to unify.
- **Hard-delete is admin-only and destructive.** No undo.

## Gotchas

- Restore of a row whose original name now collides with a live row returns HTTP 409 `name_conflict`. The admin has to rename either the live row or the trashed row before restoring.
- `registerTrashable` must be called at import time, before any route handler runs. Side-effecting imports are the trade-off here; keep it explicit.
- If you're adding a trashable entity, write the name-munging audit grep into the PR description so reviewers can verify the list/get filter.

## Related

- [ADR 0025 — Soft-delete and trash bin](../../adr/0025-soft-delete-and-trash.md)
- [`translation-pipeline.md`](./translation-pipeline.md) — sidecar lifecycle interaction.
- [`../how-to/add-a-trashable-entity.md`](../how-to/add-a-trashable-entity.md).
