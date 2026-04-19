# ADR 0021 — Knowledge Base: Definitions (v1)

**Status:** Accepted
**Date:** 2026-04-18

## Context

Every project builds up vocabulary that means something specific inside the project but overlaps with a more generic meaning elsewhere. "Supplier" to one project is a supplier-of-parts, to another it's a consultancy; "chair" in a cars project refers to a car seat, not a piece of furniture. Misunderstandings between users — and between users and LLM agents — cost time and compound across tasks.

We need a per-project, user-curated dictionary that stores terminology plus up to three candidate descriptions (manual, short LLM, long LLM) and a list of external sources, and lets the project pin which description is "the" one.

This ADR documents the first sub-tab of a new **Knowledge Base** area. Later sub-tabs (FAQ, process glossary, decision registry, …) will live under the same container — v1 ships **Definitions** only.

## Decision

### Data model

One table in `src/memory/schema.sql` — append-only, no changes to existing rows:

```sql
CREATE TABLE kb_definitions (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  project              TEXT    NOT NULL,
  term                 TEXT    NOT NULL COLLATE NOCASE,
  manual_description   TEXT    NOT NULL DEFAULT '',
  llm_short            TEXT,
  llm_long             TEXT,
  llm_sources          TEXT    NOT NULL DEFAULT '[]',   -- JSON: [{title,url}]
  llm_cleared          INTEGER NOT NULL DEFAULT 0,
  llm_status           TEXT    NOT NULL DEFAULT 'idle', -- 'idle' | 'generating' | 'error'
  llm_error            TEXT,
  llm_generated_at     INTEGER,
  is_project_dependent INTEGER NOT NULL DEFAULT 0,
  active_description   TEXT    NOT NULL DEFAULT 'manual', -- 'manual' | 'short' | 'long'
  created_by           TEXT    REFERENCES users(id) ON DELETE SET NULL,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  UNIQUE(project, term)
);
```

Key shapes:

- **`term` is COLLATE NOCASE.** "Supplier" and "supplier" collide on the unique constraint — a glossary that treats them as different entries would surprise users. Setting this at the column level means retrofitting is unnecessary.
- **`llm_sources` is JSON** (same pattern as `contacts.emails`). Each entry is `{ title, url }`; URL validation rejects anything that's not http(s).
- **`llm_cleared` distinguishes two NULL states.** `llm_cleared = 0` + NULL LLM fields = *never generated yet*; `llm_cleared = 1` + NULL fields = *explicitly cleared by the user*. A future scheduled task (`kb.definition.auto_fill`) can target rows with `llm_cleared = 0 AND llm_short IS NULL` and skip explicitly cleared ones.
- **`llm_status`** is the concurrency-safety bit. `setLlmGenerating` flips it with a conditional update (`WHERE llm_status != 'generating'`) and returns whether it won the race; the route handler returns 409 to the loser so two simultaneous Generate clicks never double-bill the LLM.
- **`active_description`** names the single description considered authoritative for the project. `clearLlmFields` resets it to `'manual'` so downstream readers never point at a cleared slot.

### HTTP surface

New file `src/server/kb_routes.ts`, mounted in `routes.ts` between the contact and workspace routers:

| Method | Path | Permission |
|---|---|---|
| `GET` | `/api/projects/:p/kb/definitions` | `canSeeProject` |
| `POST` | `/api/projects/:p/kb/definitions` | `canSeeProject` |
| `GET` | `/api/projects/:p/kb/definitions/:id` | `canSeeProject` |
| `PATCH` | `/api/projects/:p/kb/definitions/:id` | `canEditDefinition` |
| `DELETE` | `/api/projects/:p/kb/definitions/:id` | `canEditDefinition` |
| `POST` | `/api/projects/:p/kb/definitions/:id/generate` | `canEditDefinition` (SSE) |
| `POST` | `/api/projects/:p/kb/definitions/:id/clear-llm` | `canEditDefinition` |
| `POST` | `/api/projects/:p/kb/definitions/:id/active` | `canEditDefinition` |

The `/kb/` namespace keeps the door open for future KB sub-resources (e.g. `/kb/faqs/…`) without re-carving URLs. Every mutation emits `ctx.queue.log({ topic: "kb", kind: "definition.<verb>", userId, data })`.

### LLM generation flow

`handleGenerate` mirrors the document / whiteboard edit-mode shape — `runAgent` with `systemPromptOverride`, hidden session, SSE response:

1. Conditional `setLlmGenerating`. Lost race → **409 Conflict** (no queue log, no agent call).
2. Create a hidden session `kb-def-<uuid>` via `setSessionHiddenFromChat` so the generation run is auditable in Messages (admin) but stays out of the chat sidebar.
3. `runAgent({ webCfg: ctx.cfg.web, tools: toolsRegistry, systemPromptOverride: DEFINITION_SYSTEM_PROMPT })`. Passing `webCfg` automatically splices `web_search` + `web_fetch` into the per-run registry via `buildRunRegistry` in `src/agent/loop.ts`. The agent's job is to return *exactly one fenced JSON block* with `{ shortDescription, longDescription, sources }`.
4. Parse the final answer with `extractDefinitionJson` — prefers a ` ```json ` fence, then a bare ` ``` ` fence, then scans raw braces. Drops source entries that are not valid http(s) URLs.
5. On success → `setLlmResult` + emit a `kb_definition_generated` SSE event + queue-log. On missing/invalid JSON → `setLlmError` + `definition.generate.parse_error` log + renderer error event. A `try / catch / finally` wrapper guarantees the row never stays `generating` on a thrown path (the `finally` writes `setLlmError("interrupted")`).

### Project-dependent generation

A per-definition `is_project_dependent` toggle (default off) changes the shape of the user message sent to the LLM:

- **Off:** `Define the term: "chair"`.
- **On:** `Project: cars\nProject context: <project.description || project.name>\n\nDefine the term (blend with project context when forming search queries): "chair"`.

The system prompt instructs the agent to blend the term with the project domain before calling `web_search` — the desired effect is that in a cars project the term "chair" triggers a search for "car seat", not bare "chair". The fallback from empty `project.description` to project **name** prevents the toggle from becoming a no-op.

### Frontend

Navigation — new top-level `Knowledge Base` item in the Content nav group, using the `Library` icon (added to `web/src/lib/icons.ts`). Tab content is `KnowledgeBaseTab.tsx`, a sub-tab shell mirroring `WorkspaceTab.tsx`; the only sub-tab today is `DefinitionsTab.tsx`.

Definitions tab:
- Single-pane layout — search field + **+ New definition** button + card grid. No second sidebar.
- Each card shows the term, active-description badge (Manual / Short / Long), LLM status chip (`Not generated` / `Generating…` / `AI filled` / `Cleared` / `Error`), and a preview of the active description.
- Click a card → `DefinitionDialog.tsx`. Dialog owns: term input, manual description textarea, project-dependent checkbox, the three read-only LLM panels with a radio group for `active_description`, sources list, **Generate** / **Regenerate** / **Clear** buttons, and a live streaming log of tool calls during generation.
- The dialog streams generation events via `fetch` body-reader (not `EventSource`; we POST and a plain `fetch` gives us access to the SSE stream + custom events).

### Permissions

- **View** — anyone who can see the project.
- **Mutate** — admin, project owner, or definition creator (same shape as `canEditContact`).
- Concurrent Generate clicks on the same row → 409 for the loser.

### Out of scope for v1

- Scheduled auto-fill handler. Data model supports it; registering the `kb.definition.auto_fill` handler is a follow-up.
- Ask/edit chat modes (the document/contact pattern). Generation is the only LLM interaction for definitions.
- Groups, tags, categories.
- Additional Knowledge Base sub-tabs.

## Consequences

- One new table plus one new HTTP router — the lightest possible addition.
- Re-uses the edit-mode / hidden-session / `systemPromptOverride` pattern that already powers Documents, Whiteboards and Contacts. No new infrastructure.
- `web_search` + `web_fetch` are inherited automatically through `buildRunRegistry` when `webCfg` is passed — no tool-registration ceremony on the KB side.
- The `llm_cleared` + `llm_status` split lets future automation batch-fill unfilled definitions without clobbering explicitly-cleared ones.

## Future work

- **`kb.definition.auto_fill` scheduler.** Select rows `WHERE llm_cleared = 0 AND llm_short IS NULL AND llm_status != 'generating'`, project-scoped. Reuse `handleGenerate`'s generation core.
- **Boot-time stuck-state sweep.** A process kill (OOM / SIGKILL) between `setLlmGenerating` and `setLlmResult` leaves a row in `'generating'` permanently. On server start, run `UPDATE kb_definitions SET llm_status='error', llm_error='interrupted' WHERE llm_status='generating'`. Alternative: add `llm_status_at` and let the scheduler reset rows older than *N* minutes. Decision deferred to the scheduler implementation.
- **Recall injection.** Expose active definitions to the agent loop (`runAgent`) so the LLM can answer questions using the project's canonical terminology.
- **Export / import.** vCard has no analog; a simple JSON or markdown export would be enough.

## Change log

### 2026-04-18: SVG illustrations

Per-definition LLM-generated SVG illustration, kept on the same row as an independent second artifact.

- **Storage.** Four append-only columns on `kb_definitions`: `svg_content` (raw SVG markup), `svg_status ∈ {idle, generating, error}`, `svg_error`, `svg_generated_at`. No sidecar table, no translation (SVG is language-neutral like `llm_sources`).
- **State machine.** `setSvgGenerating` / `setSvgResult` / `setSvgError` / `clearSvgFields` mirror the LLM helpers 1:1 — same conditional-UPDATE race guard, same `try/catch/finally` discipline in the route handler. The two state machines operate independently, so text and illustration generation can't collide.
- **Generation.** `POST /api/projects/:p/kb/definitions/:id/generate-illustration` (SSE) runs `runAgent` with `ILLUSTRATION_SYSTEM_PROMPT` and **no `webCfg`**. Web tools add latency and non-determinism without improving the drawing; pure LLM generation is enough. The user message embeds the term plus any filled short / long / manual descriptions with explicit labels, so the model knows what the definition means before drawing it. The model returns a fenced ` ```svg ` block; `extractSvgBlock` also tolerates a bare ` ``` ` fence or a raw `<svg>…</svg>` match, and caps payloads at 200 KB.
- **Display.** Rendered via `<img src="data:image/svg+xml,${encodeURIComponent(svgContent)}">`. No `;charset=…` / `;utf8` parameter: UTF-8 is the default for text MIME types in data URLs, and bare `;utf8,` tokens are technically malformed under RFC 2397's `name=value` grammar even though most browsers tolerate them. The `<img>` context isolates any stray `<script>` or event handlers in model output — no runtime execution, no sanitizer dependency. `encodeURIComponent` (not `btoa(unescape(...))`) avoids the deprecated `unescape` global and stays cheap enough to run per-card on every render. Shown as a full-size panel inside `DefinitionDialog` and as a miniature `kb-card__illustration` thumbnail in the grid so users can see at a glance which definitions have illustrations.
- **Why amend 0021 rather than a new ADR.** The feature is a second LLM-driven artifact on the existing row using the same state-machine + SSE + dialog patterns. No new architectural primitive. If a future iteration needs a dedicated table or renderer (e.g. vector-animated illustrations, per-language variants) that would merit its own ADR.
