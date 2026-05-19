# Add a trashable entity

## When you need this

A user-facing entity should be soft-deletable — showing up in the admin **Trash** tab with Restore / Delete-forever actions. Existing trashable kinds: `document`, `whiteboard`, `contact`, `kb_definition`.

## Steps

1. **Add two columns to the entity table.** In `src/memory/schema.sql`:
   ```sql
   deleted_at INTEGER,        -- ms; non-null ⇒ soft-deleted
   deleted_by TEXT            -- user.id; no FK so legacy rows survive
   ```
   And add a trash index:
   ```sql
   CREATE INDEX IF NOT EXISTS idx_<entity>_trash
     ON <entity>(deleted_at) WHERE deleted_at IS NOT NULL;
   ```

2. **Register the kind.** In `src/memory/<entity>.ts`, at the top level:
   ```ts
   import { registerTrashable } from "./trash";
   import { createTranslationSlots } from "./translatable"; // if applicable

   registerTrashable({
     kind: "my_entity",
     table: "my_entities",
     nameColumn: "name",         // or "term" for KB — the UNIQUE column
     hasUniqueName: true,        // set false if no UNIQUE(project, name) constraint
     translationSidecar: "my_entity_translations", // optional
     reseedTranslations: (db, id) => createTranslationSlots(db, "my_entity", id),
   });
   ```

3. **Audit every list/get query.** Every query against the entity table must carry `AND deleted_at IS NULL`:
   ```sh
   rg 'FROM my_entities\b' src/
   ```
   Zero hits without the predicate.

4. **Change DELETE to soft-delete.** The existing `DELETE /api/<entity>/:id` route should call `softDelete`, not a hard DELETE. Include `soft: true` in the queue log payload:
   ```ts
   softDelete(db, "my_entity", id, ctx.user);
   void ctx.queue.log({
     topic: "my_entity",
     kind: "delete",
     userId: ctx.user.id,
     data: { id, soft: true },
   });
   ```

5. **Test the restore path.** Soft-delete a row, verify it disappears from `GET /api/<entity>` and appears in `GET /api/trash`, restore it, verify it reappears in the list and its translation sidecars are reseeded.

## Rules

- **Name-munging is inside the transaction.** `softDelete` renames the row to `__trash:<id>:<original>` in the same transaction that sets `deleted_at`.
- **Every list/get filters `deleted_at IS NULL`.** The grep audit is the canary.
- **Drop translation sidecars on soft-delete.** `registerTrashable` does this automatically if you set `translationSidecar`.
- **Reseed translations on restore.** Provide a `reseedTranslations` callback.
- **Restore can return 409 `name_conflict`.** If another live row now holds the original name. The admin has to resolve.

## Validation

```sh
# 1. Grep audit
rg 'FROM my_entities\b' src/ | grep -v 'deleted_at IS NULL'
# Expect zero results.

# 2. Test suite
bun test tests/memory/<entity>.test.ts tests/memory/trash.test.ts
```

Manual: Create row → DELETE → verify gone from list → verify in `GET /api/trash` → Restore → verify back in list. If the entity is translatable, watch the sidecars rebuild.

## Related

- [`../concepts/soft-delete-and-trash.md`](../concepts/soft-delete-and-trash.md)
- [ADR 0025 — Soft-delete and trash bin](../../adr/0025-soft-delete-and-trash.md)
- `src/memory/documents.ts` — reference implementation.
