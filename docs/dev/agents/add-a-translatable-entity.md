# Add a translatable entity

## When you need this

A new user-facing entity needs multi-language support. Existing translatable kinds: `kb_definition`, `document`, `contact`, `board_card`. A fifth requires five deliberate touches.

## Steps

1. **Add source-tracking columns to the entity table.** In `src/memory/schema.sql`:
   ```sql
   original_lang   TEXT,                         -- ISO 639-1 of the source fields
   source_version  INTEGER NOT NULL DEFAULT 1,   -- bumps on every source-field edit
   ```

2. **Add a sidecar table.** In `src/memory/schema.sql`, mirror the shape of `document_translations`:
   ```sql
   CREATE TABLE <entity>_translations (
     id              INTEGER PRIMARY KEY AUTOINCREMENT,
     <entity>_id     INTEGER NOT NULL REFERENCES <entity>(id) ON DELETE CASCADE,
     lang            TEXT    NOT NULL,
     -- translated source fields (e.g. `name`, `content_md`)
     status          TEXT    NOT NULL DEFAULT 'pending',
     error           TEXT,
     source_version  INTEGER NOT NULL,
     source_hash     TEXT,
     translating_at  INTEGER,
     created_at      INTEGER NOT NULL,
     updated_at      INTEGER NOT NULL,
     UNIQUE(<entity>_id, lang)
   );
   CREATE INDEX idx_<entity>_trans_lookup  ON <entity>_translations(<entity>_id, lang);
   CREATE INDEX idx_<entity>_trans_pending ON <entity>_translations(status, source_version);
   ```

3. **Register the kind.** In `src/memory/<entity>.ts`, at the top level:
   ```ts
   import { registerKind } from "./translatable";

   registerKind({
     kind: "my_entity",
     table: "my_entities",
     sidecarTable: "my_entity_translations",
     sourceFields: ["name", "content"],
     aliveFilter: "deleted_at IS NULL",
   });
   ```

4. **Hook into the lifecycle.**
   - `createMyEntity` must end with `createTranslationSlots(db, "my_entity", id)` so sidecars exist for every non-original language.
   - Every source-field edit path must call `markAllStale(db, "my_entity", id)` — the scheduler filter is `status = 'pending'`, so without this call, translations silently drift.

5. **Update `SseTranslationGeneratedEvent`.** In `src/agent/sse_events.ts`, add `"my_entity"` to the `kind` union.

6. **Extend `TRANSLATABLE_REGISTRY`.** In `src/server/translation_routes.ts`, add an entry so `GET/POST /api/projects/:p/translations/my_entity/:id*` dispatches correctly.

7. **Backfill test.** Verify `backfillTranslationSlotsForProject` handles the new kind — pre-existing rows must get sidecars on language expansion.

## Rules

- **`markAllStale` is load-bearing.** Miss it once and translations drift.
- **Use `source_hash` for cheap revert detection.** The scheduler short-circuits to `ready` without an LLM call if the hash matches.
- **`aliveFilter` keeps trashed/archived rows out of backfill.** Respect the entity's own lifecycle.
- **Hook into `reseedTranslations` for trash.** See [`./add-a-trashable-entity.md`](./add-a-trashable-entity.md) — restore must reseed sidecars.

## Validation

```sh
bun test tests/translation/
```

Manual:

1. Create a new entity in a project with `languages = ["en", "de"]`.
2. Verify `my_entity_translations` has `(entity_id, "de", status="pending")` immediately after create.
3. Wait for (or run-now) `translation.auto_translate_scan` — status should flip to `ready`.
4. Edit the source → sidecar flips back to `pending` → translator re-runs.
5. Revert the edit → hash match → `ready` without LLM call.

## Related

- [`../concepts/translation-pipeline.md`](../concepts/translation-pipeline.md)
- [ADR 0022 — Multi-language translation](../../adr/0022-multi-language-translation.md)
- `src/memory/documents.ts` — reference implementation.
