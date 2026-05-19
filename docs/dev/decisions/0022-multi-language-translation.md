# ADR 0022 — Per-project multi-language translation

**Status:** Accepted
**Date:** 2026-04-18

## Context

Bunny is single-language today: every entity a project owns (KB definitions, documents, contacts' `notes`, board cards) exists in exactly one language — whichever the user typed it in. Multilingual teams either hand-translate (slow) or tolerate cognitive friction ("the docs are in NL, the EN user just ignores the content column").

We want a general principle that projects can be marked as supporting multiple languages; every entity is authored in one **source language** and machine-translated to the project's other languages. Translations are read-only; only the source can be edited. This is not a one-off for any single entity type — it's a cross-cutting feature that should drop into future entities with minimal cost.

## Decision

### 1. Data model

#### Project-level
Two new columns on `projects`:

```sql
ALTER TABLE projects ADD COLUMN languages TEXT NOT NULL DEFAULT '["en"]';       -- JSON array of ISO 639-1
ALTER TABLE projects ADD COLUMN default_language TEXT NOT NULL DEFAULT 'en';    -- must ∈ languages
```

`validateLanguages` in `src/memory/projects.ts` enforces: non-empty array, lowercase 2-letter codes, default ∈ languages.

#### User-level
```sql
ALTER TABLE users ADD COLUMN preferred_language TEXT;  -- nullable; null = inherit project default
```

`normalisePreferredLanguage` in `src/auth/users.ts` rejects non-ISO codes.

#### Per-entity tracking columns
Added to each translatable entity table (`kb_definitions`, `documents`, `contacts`, `board_cards`):

```sql
original_lang   TEXT,                          -- ISO 639-1 of the source
source_version  INTEGER NOT NULL DEFAULT 1     -- bumps on every source-field edit
```

The migration in `src/memory/db.ts:migrateColumns` backfills `original_lang` from the project's `default_language` for every legacy row — a one-shot update so `GET` is still idempotent post-migration.

#### Four sidecar tables

Shape is identical across all four; only the translated columns differ. Example:

```sql
CREATE TABLE kb_definition_translations (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  definition_id      INTEGER NOT NULL REFERENCES kb_definitions(id) ON DELETE CASCADE,
  lang               TEXT    NOT NULL,
  term               TEXT,
  manual_description TEXT,
  llm_short          TEXT,
  llm_long           TEXT,
  status             TEXT    NOT NULL DEFAULT 'pending', -- 'pending'|'translating'|'ready'|'error'
  error              TEXT,
  source_version     INTEGER NOT NULL,
  source_hash        TEXT,                               -- sha256 of source fields
  translating_at     INTEGER,                            -- Unix ms; cleared on terminal state
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  UNIQUE(definition_id, lang)
);
```

`llm_sources` stays on `kb_definitions` only — URLs are language-neutral, duplicating them buys nothing.

Analogous tables: `document_translations` (name + content_md), `contact_translations` (notes), `board_card_translations` (title + description).

### 2. Shared `translatable.ts` abstraction

Four sidecar tables share the same state machine, so the code is one module:
`src/memory/translatable.ts` defines a `TranslatableKind` metadata type and emits the shared CRUD:

- `registerKind(kind)` — each memory module registers its kind on import.
- `markAllStale(db, kind, entityId)` — bumps `source_version`, flips every sidecar row to `pending`. Called from every source-field UPDATE path (`updateDefinition`, `updateDocument`, `updateContact`, `updateCard`, plus the KB flows that mutate LLM-generated fields).
- `ensureLanguageRows(db, kind, entityId, originalLang, projectLanguages, sourceVersion)` — seeds `pending` rows for every non-source language. Idempotent via `ON CONFLICT DO NOTHING`.
- `createTranslationSlots(db, kind, entityId)` — wrapper called at entity-create time that joins the project's languages and original_lang then calls `ensureLanguageRows`.
- `claimPending(db, kind, limit, now)` — atomic transaction: select pending rows, flip them to `translating`, stamp `translating_at`. Matches the conditional-UPDATE lock pattern from `setLlmGenerating`.
- `setReady` / `setError` / `markReadyNoop` — terminal-state transitions.
- `computeSourceHash(fields)` — sha256 over sorted JSON of the source fields. Normalises `null`/`undefined`/`""` into one value so the edge cases are stable.
- `sweepStuckTranslating(db, kind, thresholdMs, now)` — used only by the daily sweep task.

Adding a fifth translatable entity becomes a `registerKind({...})` call plus the matching sidecar table in `schema.sql`.

### 3. Staleness uses two coordinates

Per-entity `source_version INTEGER` bumps on every source-field edit — the cheap "who's stale" filter. Per-sidecar `source_hash` stores the hash of source fields at translation time. Before the handler calls the LLM, it compares the live hash to the stored one — a match means edit→revert happened and `markReadyNoop` skips the LLM call while stamping the new `source_version`. This gives us zero-cost revert without per-field granularity (one hash over the whole set of source fields).

### 4. Auto-translate handler

`src/translation/auto_translate_handler.ts` — cron `*/5 * * * *`. Per tick, for each registered kind:

1. `claimPending(db, kind, maxPerTick, now)`.
2. For each claimed row:
   - Resolve entity + project. If the row targets a language no longer in `project.languages`, flip to `error` (soft-orphan).
   - Compare `computeSourceHash(entity.fields)` to `row.sourceHash`. Match → `markReadyNoop`, skip LLM.
   - If any source field exceeds `cfg.translation.maxDocumentBytes`, `setError` with an oversize message (no chunking in v1).
   - Else call `runAgent` with a fixed `TRANSLATION_SYSTEM_PROMPT`, hidden session `translate-<kind>-<uuid>`, no web tools.
   - Parse the fenced JSON (`extractTranslationJson`), `setReady` on success, `setError` on parse failure.

All four kinds route through the same translate function — including KB definitions. We **translate** `llm_short` and `llm_long` rather than regenerating them in-language because regeneration hits different search results per language and produces materially different definitions. Translation keeps the semantic content locked to the source. (Accepted trade-off: the Dutch version of a term may cite English sources that happened to drive the original generation.)

### 5. Stuck-row recovery

Per-translation claims are atomic, but a SIGKILL mid-call leaves a row in `translating` forever; `claimPending` only picks up `pending` rows. Rather than re-scan inside every auto-translate tick, a separate system-handler `translation.sweep_stuck` (cron `0 3 * * *`, daily at 03:00) walks every sidecar table and flips any row with `status='translating' AND translating_at < now - cfg.translation.stuckThresholdMs` back to `pending`.

Trade-off: a stuck row has up to a 24-hour recovery window. Acceptable — stuck rows only happen on process death mid-call, which is rare. The separation keeps the per-tick handler lean and gives admins an obvious knob in the Tasks tab.

No boot-time sweep — a restart shouldn't silently retry any background work.

### 6. UI

#### Project languages editor
`web/src/components/ProjectDialog.tsx` adds a chip-grid multi-select for `languages` plus a `<select>` for `default_language`. Validates client-side that default ∈ languages; the server re-validates.

#### User preferred language
`web/src/pages/SettingsPage.tsx` adds a `preferred_language` `<select>` with a blank "Follow project default" option.

`resolveActiveLang({user, project, entity})` in `web/src/lib/resolveActiveLang.ts` is the authoritative fallback chain for which tab opens first:

1. `user.preferredLanguage` — iff in `project.languages`.
2. `project.defaultLanguage`.
3. `entity.originalLang`.
4. `project.languages[0]` — last resort; never returns anything outside `project.languages`.

This means an EN user opening a NL-source entity lands on the EN translation tab (read-only); clicking the NL tab reveals the editable source.

#### TranslationsPanel primitive
`web/src/components/TranslationsPanel.tsx` drops into every entity dialog and owns:
- tabstrip rendered via `<LanguageTabs>` (reuses `.kb-chip` classes for status pills).
- source tab renders a hint pointing the user at the dialog's source-edit form above.
- translation tabs render the sidecar fields read-only (plain text, or `<MarkdownContent>` for fields named in `markdownFields`) plus a "Translate now" button that posts to `POST /api/projects/:p/translations/:kind/:id/:lang`.
- polling — refetches every 5 s while any translation is in `pending` or `translating`. Stops when all are terminal.

**UI layout compromise (vs. plan design-choice #6).** The plan described a single language-tabstrip where the *source tab itself is the editable form*. What ships keeps the dialog's existing source-edit form as the primary body and renders the tabstrip as a panel below it; the source tab in the panel shows a hint pointing upward rather than owning the editable controls. Two reasons:
1. Each entity dialog has bespoke source-edit UI (Tiptap for documents, ProseMirror-free for KB, etc.) — hoisting that into a generic tabstrip renderer would have forced a render-props protocol that touched all four dialogs and ballooned scope.
2. The source tab still exists and is still labelled "Source", so the conceptual model holds: the user sees the full language set and knows which one is editable. Clicking the source tab points them at the form above rather than rendering a duplicate.
If future usage reveals confusion ("I clicked the NL tab, why am I not typing into the translation?"), the tabstrip can absorb the source-edit UI per entity without changing the data model.

Polling is a deliberate v1 simplification: all current SSE sinks are session-scoped, and there's no project-room broadcast. A future abstraction can emit `translation_generated` events to subscribers in that room without changing the data model (the event type is already in `src/agent/sse_events.ts`).

#### LangBadge list-row placement (deferred)
`<LangBadge>` is shipped as a primitive and wired into the **KB definitions** card grid (next to the term) so the source language is visible without opening the dialog. The plan also called for the same treatment on documents list, contacts card grid, and board columns — those are deferred to keep the initial PR scoped. The component is ready to drop in; each remaining integration is a three-line change to the respective list renderer.

#### Soft-orphan
When a language is removed from `project.languages`, existing sidecar rows are kept. The backend's GET surface sets `isOrphaned=true` on them. Re-adding the language resurfaces them (stale if `source_version` moved). Hard-delete is never done — it's user-destructive and irreversible.

### 7. HTTP surface

Two new endpoints under a single route handler (`src/server/translation_routes.ts`):

- `GET /api/projects/:project/translations/:kind/:id` — returns project languages + default + the full translation list with `isOrphaned` computed. Auth: `canSeeProject`.
- `POST /api/projects/:project/translations/:kind/:id/:lang` — flips the sidecar row to `pending` and kicks the scheduler's translation task via `scheduler.runTask` so the user doesn't wait 5 minutes. Auth: per-entity edit permission (`canEditDefinition`, `canEditDocument`, `canEditContact`, `canEditCard`).

Both are kind-agnostic — dispatched via `TRANSLATABLE_REGISTRY`.

### 8. Config

New `[translation]` block in `bunny.config.toml`:

```toml
[translation]
max_per_tick = 20         # cap on sidecar rows translated per 5-min tick
max_document_bytes = 30720 # 30 KB — larger sources land in status=error
stuck_threshold_ms = 1800000 # 30 min — rows translating longer get swept
system_prompt = ""        # empty = hard-coded default
```

Env override: `TRANSLATION_MAX_PER_TICK`.

## Consequences

- Every entity gains a sidecar row per non-source language, sized with two TEXT columns on average. A 1000-entity project in 3 languages = 2000 sidecar rows plus one copy of each translated field. The overhead is negligible vs. the value of read-access for non-source-language users.
- The LLM bill grows linearly with entities × languages on first translation. The hash-skip path keeps edit→revert loops free, which is the main write pattern.
- Four source-field edit paths gained a `markAllStale` call. If a fifth entity is added without that call, its translations will silently drift. Reviewers should treat `markAllStale` on source-field-change as a load-bearing convention.
- UI polling is a stand-in for SSE fan-out. It's fine while ≤ ~100 users have entity dialogs open simultaneously; beyond that we should invest in the project-room abstraction.

## Alternatives considered

- **Polymorphic `translations` table keyed by `(entity_type, entity_id, lang)`.** Fewer tables, weaker types, no referential integrity on per-entity fields. Rejected — violates the "schema is append-only and typed" principle from CLAUDE.md.
- **Regenerate KB short/long in the target language instead of translating.** Different search queries per language produce different sources — the Dutch and English definitions diverge. Rejected — we optimise for consistency across languages, not domain-aware freshness.
- **Per-field translations with one hash per field.** Four sidecar rows per language × number of source fields — combinatoric UX and 4× LLM calls. Rejected — whole-set hashing is the right granularity.
- **Embed sweep inside the auto-translate tick.** Tight coupling, harder to disable from the Tasks tab. Rejected — separate daily task is cleaner.
- **Boot-time stuck sweep.** Silently retries failed background work on every `startServer`, breaks the idempotent-boot invariant. Rejected — daily task is safer.
- **Chunked translation for oversize documents.** Needs markdown-AST awareness; half-shipping is worse than a clear error. Deferred — hit the limit first, implement properly later.
- **Change-source-language flow (v2).** Runtime-only; no schema impact. Deferred until users ask for it.

## References

- Plan: `/Users/christiaansiebeling/.claude/plans/1a-2-voorkeur-3-squishy-treehouse.md`
- ADR 0011 (scheduled tasks)
- ADR 0021 (KB definitions — translation state machine is mirrored)
