# Knowledge Base (Definitions)

## What it is

Sub-tab shell with one v1 sub-tab: **Definitions** — a per-project dictionary of project-specific terminology. Each definition holds a manual description + LLM-generated short + long + sources, plus (independently) an LLM-generated SVG illustration. A single-choice `active_description` picks which of the three text descriptions is authoritative.

## Data model

```sql
CREATE TABLE kb_definitions (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  project              TEXT    NOT NULL,
  term                 TEXT    NOT NULL COLLATE NOCASE,
  manual_description   TEXT    NOT NULL DEFAULT '',
  llm_short            TEXT,
  llm_long             TEXT,
  llm_sources          TEXT    NOT NULL DEFAULT '[]',   -- [{title,url}]
  llm_cleared          INTEGER NOT NULL DEFAULT 0,      -- 1 = user explicitly cleared
  llm_status           TEXT    NOT NULL DEFAULT 'idle', -- 'idle' | 'generating' | 'error'
  llm_error            TEXT,
  llm_generated_at     INTEGER,
  is_project_dependent INTEGER NOT NULL DEFAULT 0,
  active_description   TEXT    NOT NULL DEFAULT 'manual', -- 'manual' | 'short' | 'long'
  original_lang        TEXT,
  source_version       INTEGER NOT NULL DEFAULT 1,
  svg_content          TEXT,
  svg_status           TEXT    NOT NULL DEFAULT 'idle',
  svg_error            TEXT,
  svg_generated_at     INTEGER,
  created_by           TEXT    REFERENCES users(id) ON DELETE SET NULL,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  deleted_at           INTEGER,
  deleted_by           TEXT,
  UNIQUE(project, term)
);
```

`term COLLATE NOCASE` on the UNIQUE — so "Supplier" and "supplier" collide.

Plus `kb_definition_translations` sidecar — source fields: `term`, `manual_description`, `llm_short`, `llm_long`. `llm_sources` is language-neutral and stays on the entity row.

## HTTP API

- `GET/POST /api/projects/:p/kb/definitions` — list (excludes trashed) + create.
- `GET/PATCH/DELETE /api/projects/:p/kb/definitions/:id` — CRUD. DELETE is soft.
- `POST /api/projects/:p/kb/definitions/:id/generate` — SSE. Generates `short` + `long` + `sources`.
- `POST /api/projects/:p/kb/definitions/:id/clear-llm` — wipes LLM fields, sets `llm_cleared = 1`.
- `POST /api/projects/:p/kb/definitions/:id/active` — sets `active_description` to `manual` / `short` / `long`.
- `POST /api/projects/:p/kb/definitions/:id/generate-illustration` — SSE. Generates SVG.
- `POST /api/projects/:p/kb/definitions/:id/clear-illustration` — wipes SVG fields.

## Code paths

- `src/memory/kb_definitions.ts` — CRUD + `canEditDefinition` + state-machine helpers:
  - `setLlmGenerating` / `setLlmResult` / `setLlmError` / `clearLlmFields`
  - `setSvgGenerating` / `setSvgResult` / `setSvgError` / `clearSvgFields`
  - Calls `registerTrashable`, `registerKind`.
- `src/server/kb_routes.ts`.
- `src/agent/loop.ts:runAgent` with a fixed `DEFINITION_SYSTEM_PROMPT` or `ILLUSTRATION_SYSTEM_PROMPT`.

## UI

- `web/src/tabs/KnowledgeBaseTab.tsx` — sub-tab shell (mirrors WorkspaceTab).
- `web/src/tabs/kb/DefinitionsTab.tsx` — single-pane card grid; each card shows the active description preview + SVG thumbnail.
- `web/src/components/DefinitionDialog.tsx` — form + project-dependent checkbox + three read-only LLM panels with a radio group + Generate/Clear controls + SVG panel + live tool-call log during generation.

## Extension hooks

- **Translation:** yes — four text source fields through one prompt (KB short/long are *translated*, not regenerated per language). See `../concepts/translation-pipeline.md`.
- **Trash:** yes. Soft-delete renames `term` to `__trash:<id>:<term>` to avoid `UNIQUE(project, term)` collisions.
- **Notifications:** no.
- **Scheduler:** a future `kb.definition.auto_fill` handler can target rows where `llm_cleared = 0` AND `llm_short IS NULL` (distinguishes "never generated" from "explicitly cleared").
- **Tools:** none — generation is a dedicated endpoint, not an agent tool.

## Text generation flow

```
POST /generate { definitionId }
  → conditional UPDATE: set llm_status = 'generating' WHERE llm_status != 'generating'
    (lost race → 409)
  → hidden session kb-def-<uuid>
  → runAgent({
      systemPromptOverride: DEFINITION_SYSTEM_PROMPT,
      webCfg: ctx.cfg.web,                -- auto-splices web_search / web_fetch
      askUserEnabled: false,
      mentionsEnabled: false,
    })
  → model returns ```json { shortDescription, longDescription, sources } ```
  → extractDefinitionJson → setLlmResult
  → SSE: { type: "kb_definition_generated", definitionId, sources }
  → try/catch/finally guarantees the row never stays 'generating'
```

**Project-dependent mode** blends the term with the project description before searching. Example: in a project about cars, the term "chair" is searched as "car seat", not bare "chair".

**Source language** is explicit, not inferred. The user prompt (`buildDefinitionPrompt`) names a `targetLang` for `shortDescription` / `longDescription`, resolved as `definition.original_lang ?? project.default_language ?? "en"` — mirroring the translation pipeline's source-language precedence. The system prompt instructs the model to write in that language and treat the manual description as its strongest stylistic reference. This avoids language-from-script guesses (e.g. a code-shaped term like `EN 342` in a Dutch project would otherwise be answered in English).

## SVG illustration flow

Parallel column set + handlers so text and illustration generation cannot collide:

```
POST /generate-illustration { definitionId }
  → setSvgGenerating (409 on lost race)
  → runAgent({
      systemPromptOverride: ILLUSTRATION_SYSTEM_PROMPT,  -- term + filled descriptions
      webCfg: NOT passed                                 -- pure generation, no web tools
      askUserEnabled: false,
    })
  → model returns ```svg <svg>…</svg>```
  → extractSvgBlock (tolerates bare fences or raw <svg>…</svg>)
  → cap 200 KB
  → setSvgResult
  → SSE: { type: "kb_definition_illustration_generated", definitionId, bytes }
```

Rendered via `<img src="data:image/svg+xml,${encodeURIComponent(svg)}">`:

- `<img>` context isolates any stray `<script>` in model output — no sanitizer needed.
- The data URL uses no `;charset=…` / `;utf8` parameter. UTF-8 is the default for text MIME types; bare `;utf8,` is technically malformed under RFC 2397 even though most browsers tolerate it.
- Both full-size (inside `DefinitionDialog`) and a miniature thumbnail on the card.

## `llm_cleared` semantics

Distinguishes two states:

- **Never generated** — `llm_cleared = 0`, LLM fields NULL. Future auto-fill scheduler target.
- **Explicitly cleared** — `llm_cleared = 1`, LLM fields NULL. Auto-fill skips.

## Key invariants

- **Text and illustration are independent.** Two column sets, two handlers, two prompts.
- **Conditional UPDATE prevents double-generation.** Lost race → 409.
- **`try/catch/finally` guarantees no stuck `generating` rows.**
- **Translations are translations, not regenerations.** KB short/long go through the translation prompt like any other field.
- **Illustration has no web tools.** Pure generation from text.

## Gotchas

- `term COLLATE NOCASE` means "Supplier" and "supplier" collide. Design the UX to be case-insensitive.
- `extractDefinitionJson` parses one fenced JSON block. Models that emit multiple blocks or unfenced output will fail — the system prompt enforces the shape.
- The generation endpoint is SSE — long-lived. `Bun.serve idleTimeout: 0` handles it.
- Queue logging uses `topic: "kb"`.

## Related

- [ADR 0021 — Knowledge Base: definitions](../../adr/0021-knowledge-base-definitions.md)
- [`../concepts/translation-pipeline.md`](../concepts/translation-pipeline.md)
- [`../concepts/soft-delete-and-trash.md`](../concepts/soft-delete-and-trash.md)
- [`../reference/sse-events.md`](../reference/sse-events.md)
