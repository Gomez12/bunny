# Translation pipeline

## At a glance

Per-project multi-language support. Each project has a `languages` list + `default_language`; every translatable entity (KB definitions, documents, contacts, board cards) is authored in one *source* language and machine-translated to the rest. Translations are read-only; only the source is editable.

Two coordinates describe staleness:

- **`source_version`** on the entity — bumps on every source-field edit. Cheap filter for the scheduler.
- **`source_hash`** on the sidecar — sha256 of the source fields at translation time. If the current hash equals the stored hash, the translation short-circuits to `ready` without an LLM call (edit→revert is free).

## Where it lives

- `src/memory/translatable.ts` — `registerKind`, `createTranslationSlots`, `markAllStale`, `claimForTranslation`, `setReady`, `setError`, `backfillTranslationSlotsForProject`, `backfillAllTranslationSlots`. Shared abstraction that every entity module calls on import.
- `src/memory/kb_definitions.ts` / `documents.ts` / `contacts.ts` / `board_cards.ts` — each ends its create function with `createTranslationSlots` and calls `markAllStale` in every source-field update path.
- `src/translation/auto_translate_handler.ts` — the scheduler handler (`translation.auto_translate_scan`, cron `*/5 * * * *`).
- `src/translation/sweep_stuck_handler.ts` — daily sweep for rows stuck in `translating` (`translation.sweep_stuck`, cron `0 3 * * *`).
- `src/server/translation_routes.ts` — `/api/projects/:p/translations/:kind/:id*`.
- `src/translation/TRANSLATABLE_REGISTRY` — map from kind → entity descriptor (tables, alive filter, reseed hook).

## The four sidecar tables

Same shape in each:

| Column | Meaning |
| --- | --- |
| `<entity>_id` | FK → parent entity, `ON DELETE CASCADE` |
| `lang` | ISO 639-1 target language |
| *(source fields)* | Translated copies (`term`, `manual_description`, etc.) |
| `status` | `pending` / `translating` / `ready` / `error` |
| `error` | Translator error message (null on success) |
| `source_version` | Entity's version at translation time |
| `source_hash` | sha256 of source fields at translation time |
| `translating_at` | Set when the handler claims the row; used by the stuck-sweep |

Tables: `kb_definition_translations`, `document_translations`, `contact_translations`, `board_card_translations`.

## Lifecycle

```
entity created
   └─► createTranslationSlots(kind, id) inserts (lang, status=pending) for every
       project language except the entity's original_lang.

entity source edited
   └─► source_version += 1
   └─► markAllStale(kind, id)  flips every sidecar back to status=pending

scheduler tick (every 5 min)
   ├─► select N pending rows
   ├─► claimForTranslation(row)  sets status=translating + translating_at=now
   ├─► if source_hash matches current source → setReady (no LLM call)
   └─► else runAgent({ systemPromptOverride: translation prompt }) → JSON →
       setReady(translated fields, source_hash, source_version)
       or setError(message)

stuck sweep (daily, 03:00)
   └─► rows where translating_at < now - cfg.translation.stuck_threshold_ms
       → flip back to pending so the next tick retries.
```

## Project `languages` expansion

`updateProject` calls `backfillTranslationSlotsForProject` when `languages` grows, so every pre-existing entity gets `pending` sidecars for the new language. `startServer` calls `backfillAllTranslationSlots` once at boot as a self-healer for legacy DBs.

`TranslatableKind.aliveFilter` (e.g. `"deleted_at IS NULL"` or `"archived_at IS NULL"`) keeps trashed / archived entities out of the backfill so restore semantics stay clean.

## KB short/long — translated, not regenerated

All four KB source fields (`term`, `manual_description`, `llm_short`, `llm_long`) go through the same translation prompt. Running the KB-generation agent per language would produce divergent definitions — translating them instead keeps them semantically locked to the source. `llm_sources` stays on the entity row (URLs are language-neutral).

## Orphaned languages

Removing a language from `project.languages` leaves sidecar rows in place — they read back as `isOrphaned = true`. Re-adding resurfaces them. Never hard-delete; the user may have re-added the language by accident.

## User `preferred_language`

`users.preferred_language` overrides the project default for that user. `web/src/lib/resolveActiveLang.ts` chooses the tab to show: `user.preferredLanguage` (if supported by the project) → project default → entity original → first project language.

## Config

```toml
[translation]
max_per_tick = 50                   # rows claimed per scheduler tick
max_document_bytes = 50000
stuck_threshold_ms = 1_800_000      # 30 min
system_prompt = "You are a translator…"
```

`TRANSLATION_MAX_PER_TICK` is the env override.

## Key invariants

- **Translations are read-only in the UI.** Only the source is editable. Edits to a translation are disallowed at the API layer.
- **`markAllStale` is load-bearing.** Every source-field edit path must call it, or translations silently drift.
- **Hash short-circuits the LLM call.** Don't bypass this — the cost savings on edit→revert cycles are material.
- **Orphaned languages are soft-kept.** Never hard-delete on language removal.

## Gotchas

- Adding a fifth translatable entity requires (1) a new sidecar table in `schema.sql`, (2) a `registerKind` call in the entity module's top-level scope, (3) updates to every source-edit path to call `markAllStale`, (4) a `reseedTranslations` callback for restore-from-trash (see `soft-delete-and-trash.md`), (5) a new `kind` value in `SseTranslationGeneratedEvent` and `src/server/translation_routes.ts`.
- The translator's JSON output is parsed with a fenced-block extractor. Schema-level validation is minimal — be tolerant in the translator's system prompt.
- No project-room SSE broadcast exists in v1. The frontend polls every 5s while any sidecar is transient. `translation_generated` SSE events only fire when translation runs inside an active user session (via `/api/translations/:kind/:id/:lang`).

## Related

- [ADR 0022 — Multi-language translation](../../adr/0022-multi-language-translation.md)
- [`scheduler.md`](./scheduler.md) — the two system handlers live here.
- [`soft-delete-and-trash.md`](./soft-delete-and-trash.md) — trash drops sidecars; restore re-seeds them.
- [`../how-to/add-a-translatable-entity.md`](../how-to/add-a-translatable-entity.md) — step-by-step.
