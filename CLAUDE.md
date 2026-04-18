# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
bun install                    # install backend deps
cd web && bun install          # install frontend deps (separate package.json)

# Run the CLI (single turn)
bun run src/index.ts "<prompt>"
bun run src/index.ts --session <id> --hide-reasoning "<prompt>"
bun run src/index.ts --project <name> "<prompt>"   # auto-creates the project if missing

# Run the web UI (two processes)
bun run serve                  # Bun HTTP + SSE on :3000
cd web && bun run dev          # Vite dev server on :5173, proxies /api

# Tests
bun test                              # full suite
bun test tests/agent/render.test.ts   # single file
bun test -t "closes reasoning block"  # single test by name
bun test --watch

bun run typecheck              # tsc --noEmit
bun run fmt                    # prettier
bun run check                  # typecheck + test
bun run docs                   # TypeDoc → docs/api/

bun run web:build              # build web/dist/ (Bun then serves it on :3000 in prod)
bun run build                  # compile standalone binary via scripts/build.ts (all platforms + Tauri)
bun run build:platform darwin-arm64  # single-platform build
bun run build -- --no-web      # skip Vite build, reuse existing web/dist/
bun run build -- --no-client   # skip Tauri client build (useful without Rust toolchain)
bun run build -- --list        # list available build targets

# Tauri desktop client
cd client && bun install       # install client deps (separate package.json, requires Rust toolchain)
bun run client:dev             # Tauri dev mode (opens native window)
bun run client:build           # Tauri production build (platform-specific installer)
```

**Runtime requirement:** Bun ≥ 1.3.0. Node is not supported — the project relies on `bun:sqlite`, `Bun.serve`, `Bun.TOML`, `bun:test`.

**State location:** everything lands in `./.bunny/` relative to cwd (override via `$BUNNY_HOME`). Portable by design — no `$HOME/.config`. LLM/embed API keys come from env (`LLM_API_KEY`, `EMBED_API_KEY`); user-facing API keys (`BUNNY_API_KEY` for the CLI) are minted per user via the web UI. Seeded-admin credentials can be overridden with `BUNNY_DEFAULT_ADMIN_PASSWORD`. Project-level choices go in `bunny.config.toml` (incl. `[auth]` block).

## Architecture

The agent loop is a thin outer/inner loop (Mihail Eric, _The Emperor Has No Clothes_). Three design principles drive the whole codebase:

1. **Minimal agent loop** — `src/agent/loop.ts:runAgent` is the only orchestrator: build system prompt (with hybrid recall injected) → stream LLM → if tool_calls, execute in parallel → repeat until assistant answers without tools. Capped at `MAX_TOOL_ITERATIONS = 20`.
2. **Queue is the spine** — every meaningful action is a fire-and-forget job on a `bunqueue` worker (`src/queue/`) which logs to `events` in SQLite. This covers LLM requests/responses, tool calls/results, memory writes, **and** all HTTP mutations (project/board/agent/task/workspace CRUD, auth events). `LogPayload` carries an optional `userId` so every event is attributable. Every route context (`AuthRouteCtx`, `WorkspaceRouteCtx`, `AgentRouteCtx`, `ScheduledTaskRouteCtx`, `BoardRouteCtx`) includes `queue: BunnyQueue`. Nothing is invisible; nothing blocks the caller.
3. **Portable state** — single SQLite file under `$BUNNY_HOME`. Schema in `src/memory/schema.sql` (NEVER drop/rename columns — add new ones). Key tables: `messages`, `projects`, `agents`, `project_agents`, `skills`, `project_skills`, `board_swimlanes`, `board_cards`, `board_card_runs`, `scheduled_tasks`, `whiteboards`, `documents`, `contacts`, `contact_groups`, `contact_group_members`, `users`, `auth_sessions`, `api_keys`, `session_visibility`, `events`, `messages_fts` (FTS5). The `embeddings` vec0 table is created dynamically because the dimension must be baked into the CREATE statement.

### Streaming pipeline

`src/llm/adapter.ts:chat` returns `{ deltas: AsyncIterable<StreamDelta>, response: Promise<LlmResponse> }`. The SSE parser in `src/llm/stream.ts` is multi-byte safe. `src/llm/profiles.ts` normalises provider differences (OpenAI, DeepSeek, OpenRouter, Ollama, anthropic-compat) — the adapter stays provider-agnostic. Reasoning text is stored on `messages.channel='reasoning'` but NOT sent back to the LLM on the next turn, except for anthropic-compat providers that require the thinking-block signature roundtrip (`provider_sig` column).

### Renderer interface

`src/agent/render.ts` exposes a `Renderer` interface: `onDelta`, `onToolResult`, `onError`, `onTurnEnd`. Two implementations share the interface:

- `createRenderer` — ANSI/TTY for the CLI.
- `createSseRenderer` (`src/agent/render_sse.ts`) — JSON events over SSE for the web UI.

The agent loop is transport-agnostic. When adding a new front-end, implement this interface rather than branching inside `loop.ts`.

### Memory

Hybrid recall (`src/memory/recall.ts:hybridRecall`) fuses BM25 (FTS5 trigram tokenizer, `src/memory/bm25.ts`) and kNN over embeddings (`sqlite-vec`, `src/memory/vector.ts`) with Reciprocal Rank Fusion (k=60). Top-`recall_k` (default 8) messages are injected into the system prompt before each turn. Embedding failures are non-fatal — the code still runs without an `EMBED_API_KEY`.

Short-term coherence is handled separately: the last `memory.last_n` (default 10) user/assistant *content* turns of the current session are replayed verbatim in every request (`getRecentTurns` in `src/memory/messages.ts`, spliced into `runAgent`'s `messages[]` between the system prompt and the new user message). Tool-call / tool-result / reasoning rows are skipped — they belong to completed inner loops. IDs of the replayed rows are passed to `hybridRecall` via `excludeIds` so recall never duplicates what's already in the payload. Set `last_n = 0` for recall-only mode.

Both `last_n` and `recall_k` can be overridden per-project via the `last_n` / `recall_k` keys in `systemprompt.toml` (exposed as `lastN` / `recallK` in `ProjectAssets.memory` and in the project DTO). `runAgent` applies the override when present, otherwise inherits from the global `[memory]` block. The Projects tab in the web UI edits these fields alongside the system prompt.

`messages` rows are one-per-semantic-unit: separate rows for `content`, `reasoning`, `tool_result` via the `channel` column. The FTS virtual table is synced via triggers on `channel='content'` only.

### Web UI

`bunny serve` starts `Bun.serve` (`src/server/index.ts`) which:
- Routes `/api/*` through `src/server/routes.ts` (plain switch on pathname, no framework).
- Serves `web/dist/` statically if it exists; otherwise shows a dev placeholder pointing at the Vite dev server.
- Sets `idleTimeout: 0` — SSE streams can outlive the default timeout.

The frontend (`web/`) is React + Vite with its own `package.json`. Navigation is a permanent **56 px left icon-rail** (`web/src/components/Sidebar.tsx`) that expands to 240 px on hover as an absolutely-positioned overlay (VS Code pattern — no layout reflow). Nav items are grouped into four sections: **Work** (Chat, Board, Tasks), **Content** (Documents, Whiteboard, Files, Contacts), **Configure** (Workspace), **System** (Dashboard, Settings). Tabs that own a context column (Chat's `SessionSidebar`, `DocumentSidebar`, `WhiteboardSidebar`, contacts groups sidebar) keep that column inside the main area; other tabs fill the full width. Below 640 px the rail becomes a hamburger drawer. Icons come from `lucide-react` via the barrel at `web/src/lib/icons.ts` — don't import `lucide-react` directly, always go through the barrel. The rabbit mascot (`web/src/components/Rabbit.tsx`, SVG at `web/src/assets/rabbit.svg`) appears as the brand logo, a 0.04-opacity watermark anchored inside `.app-shell__main` (skipped on Dashboard via `.app-shell__main--dense`), empty-state illustrations via `<EmptyState>`, and the login/change-password hero. The visual language is canonised in **[docs/styleguide.md](./docs/styleguide.md)** — tokens, spacing scale, icon sanctioning, rabbit placements — always consult it before adding UI.

Tab behaviour: **Chat** (live SSE streaming via `fetch` body-reader, not `EventSource`, because we POST JSON; admins get a "Mine / All" scope toggle on the session sidebar, absorbing the former Messages tab). **Board** (per-project kanban — see Boards section). **Tasks** (scheduled tasks with cron — see Scheduler section). **Documents** (Tiptap WYSIWYG + LLM edit/question modes). **Whiteboard** (Excalidraw + LLM edit/question modes). **Files** (per-project workspace file browser). **Contacts** (per-project contact management with groups, search, vCard import/export). **Workspace** (inner sub-tabs for Projects / Agents / Skills — `web/src/tabs/WorkspaceTab.tsx`). **Dashboard** (KPIs, time-series charts, tool/agent/project breakdowns, error rates, scheduler health, and recent activity feed — powered by Recharts and a single `GET /api/dashboard?range=24h|7d|30d|90d|all` endpoint backed by `src/memory/stats.ts`; admin sees global stats, non-admin sees own data only). **Settings** (profile, API keys, admin-only Users and Logs sub-tabs).

The active tab is persisted in `localStorage` as `bunny.activeTab`; legacy values (`messages`, `logs`, `projects`, `agents`, `skills`) are aliased forward via `LEGACY_TAB_ALIAS` in `App.tsx`. Session id is persisted under `bunny.activeSessionId`, active project under `bunny.activeProject`. Switching project always starts a new session. The app boots by calling `GET /api/auth/me` — 401 drops the user on the login page, a `mustChangePassword` flag gates the forced-change page. All fetches use `credentials: "include"` so the `bunny_session` cookie rides along.

SSE event shapes live in `src/agent/sse_events.ts` and are imported by both `src/agent/render_sse.ts` (backend) and `web/src/api.ts` (frontend) — single source of truth, compile-time drift guard. Event types: `content`, `reasoning`, `tool_call`, `tool_result`, `usage`, `stats`, `error`, `turn_end`, `done`, `card_run_started`, `card_run_finished`. Vite's `server.fs.allow: [".."]` permits the cross-root import.

### Projects

Logical workspaces that group sessions/messages + on-disk assets. Source of truth for metadata lives in the `projects` table (name PK, description, visibility, created_by, timestamps); source of truth for the system prompt lives on disk at `$BUNNY_HOME/projects/<name>/systemprompt.toml` (`prompt`, `append`). Every `messages` row carries a `project` column; legacy NULL rows read back as `'general'` via `COALESCE(project, 'general')`. A session is locked to one project — `runAgent` errors on mismatch.

The **default project name** and the **base system prompt** both come from `[agent]` in `bunny.config.toml` (`default_project`, `system_prompt`) with env overrides `BUNNY_DEFAULT_PROJECT` / `BUNNY_SYSTEM_PROMPT`. `runAgent` takes them via `RunAgentOptions.agentCfg`; `buildSystemMessage` falls back to a hard-coded prompt only in tests. Both the CLI boot (`src/index.ts`) and `startServer` seed the configured default project at startup on top of the always-present `general` row.

Entry points: `src/memory/projects.ts` (CRUD + `validateProjectName` + `getSessionProject`), `src/memory/project_assets.ts` (`ensureProjectDir`, `loadProjectSystemPrompt`, `writeProjectSystemPrompt`). System-prompt composition happens in `src/agent/prompt.ts:buildSystemMessage` — `append=true` (default) concatenates after the base prompt, `append=false` replaces it. Recall (`hybridRecall`, `searchBM25`, `searchVector`) all accept a `project` filter so projects never leak into each other.

CLI: `--project <name>` auto-creates DB row + directory when missing. HTTP: `GET/POST /api/projects`, `GET/PATCH/DELETE /api/projects/:name`; `?project=<name>` on `/api/sessions`; optional `project` field on the `POST /api/chat` body. Web UI: "Projects" tab shows cards, click-to-switch (starts a fresh session), + dialog for create/edit. Project name is immutable (PK + dir); only description, visibility, and system prompt can change. See [ADR 0008](./docs/adr/0008-projects.md).

### Agents

Named personalities with their own system prompt, tool whitelist and memory knobs. Orthogonal to Projects: the `agents` table + `$BUNNY_HOME/agents/<name>/config.toml` hold the definition, and a `project_agents(project, agent)` join controls **where** an agent is available. Entry points live at `src/memory/agents.ts` (CRUD + link helpers), `src/memory/agent_assets.ts` (TOML asset loader), and `src/tools/call_agent.ts` (subagent invocation tool).

- `runAgent` accepts `agent?: string` and a `callDepth?: number`; it resolves `loadAgentAssets(agent)`, merges memory knobs with precedence `agent → project → global`, filters the registry via `ToolRegistry.subset(filter, extras)`, and calls `buildSystemMessage` with the agent prompt (which wins over the project prompt via `append = false` by default). When `context_scope = "own"` the loop passes the agent's name as `ownAuthor` so `getRecentTurns` + `hybridRecall` filter recall to user turns + rows authored by this agent.
- `messages.author` stamps every assistant/reasoning/tool_call/tool_result row with the responding agent's name (`NULL` = default assistant). The column is append-only — never remove.
- `POST /api/chat` accepts an optional `agent` field; otherwise `parseMention` (`src/agent/mention.ts`) strips a leading `@name` off the prompt. A mention without a trailing prompt returns 400. The agent **replaces** the default assistant for that turn — there is no fallback or double-answer.
- Subagents: enable `is_subagent = true` on an agent, then add it to another agent's `allowed_subagents`. The orchestrator then receives the built-in `call_agent(name, prompt)` tool which spawns a nested `runAgent` with a silent renderer (final answer surfaces as the tool result); depth is capped by `MAX_AGENT_CALL_DEPTH = 2`.
- SSE events (`content`, `reasoning`, `tool_call`, `tool_result`, `turn_end`) carry an optional `author`. `createSseRenderer(sink, { author })` tags every outgoing event; the frontend `MessageBubble` renders `@name` in place of `assistant`. `HistoryTurn.author` propagates the same field from replayed DB rows so reload looks identical.
- HTTP: `GET/POST /api/agents`, `GET/PATCH/DELETE /api/agents/:name`, `GET/POST /api/projects/:name/agents`, `DELETE /api/projects/:name/agents/:agent`, `GET /api/tools` (for the picker). Web UI: "Agents" tab with a card grid + dialog; per-card checkboxes to link/unlink to each project. See [ADR 0009](./docs/adr/0009-agents.md).

### Skills

Reusable instruction packages following the [agentskills.io](https://agentskills.io) open standard. A skill is a directory containing a `SKILL.md` file (YAML frontmatter + markdown instructions) plus optional `scripts/`, `references/`, and `assets/` subdirectories. Skills are passive instruction sets (no memory knobs or context scope like agents).

- **On disk:** `$BUNNY_HOME/skills/<name>/SKILL.md`. Parsed with the `yaml` npm package (TOML is used elsewhere, but SKILL.md uses YAML frontmatter per the standard). Mtime-keyed cache avoids re-parsing on every turn.
- **Database:** `skills` table (name PK, description, visibility, source_url, source_ref, created_by, timestamps) + `project_skills` join table — same opt-in linking pattern as `project_agents`.
- **Progressive disclosure:** (1) Catalog (~50-100 tokens/skill: name + description) injected into the system prompt. (2) Full SKILL.md body loaded via the `activate_skill` tool when the LLM decides a skill is relevant. (3) Bundled scripts/references loaded on demand via existing `read_file` tool.
- **`activate_skill` tool** (`src/tools/activate_skill.ts`): closure-bound per-run tool, same pattern as `call_agent`. Added to `DYNAMIC_TOOL_NAMES` in `loop.ts`. Returns instructions wrapped in `<skill_content>` tags + a `<skill_resources>` listing of bundled files.
- **Installation:** `src/memory/skill_install.ts` fetches skills from GitHub URLs (parses tree/blob URLs, uses the Contents API) and from skills.sh identifiers (resolved to GitHub). `POST /api/skills/install` exposes this over HTTP.
- Entry points: `src/memory/skills.ts` (CRUD + link helpers), `src/memory/skill_assets.ts` (SKILL.md parsing + caching), `src/memory/skill_install.ts` (GitHub/skills.sh fetcher).
- HTTP: `GET/POST /api/skills`, `POST /api/skills/install`, `GET/PATCH/DELETE /api/skills/:name`, `GET/POST /api/projects/:p/skills`, `DELETE /api/projects/:p/skills/:skill`. Web UI: "Skills" tab with card grid, create dialog, install-from-URL dialog, project link/unlink checkboxes. See [ADR 0013](./docs/adr/0013-agent-skills.md).

### Boards

Per-project Trello-style kanban with configurable swimlanes and cards. One board per project — `project` is the scope key on every row, no separate `boards` table (mirrors `project_agents`). Three append-only tables (`board_swimlanes`, `board_cards`, `board_card_runs`) live in `src/memory/schema.sql`. Sparse positions (steps of 100) make drag-and-drop reorders cheap. `createProject` seeds Todo/Doing/Done; `GET /api/projects/:p/board` backfills them on-demand for legacy projects.

Cards have a **mutually exclusive** assignee — `assignee_user_id` *or* `assignee_agent`, not both. Agent-assigned cards can be executed: `runCard` (`src/board/run_card.ts`) is the single entry point — it spawns `runAgent` detached, mirrors the streamed events into an in-memory **fanout** keyed by `runId`, and writes the final assistant answer to the run row via `markRunDone`. The fanout buffers everything so a late SSE subscriber on `/api/cards/:id/runs/:runId/stream` replays the whole run; after a 60s grace window post-close the fanout is dropped and clients fall back to `/api/sessions/:id/messages`. `trigger_kind = 'manual'` today; the same `runCard` function is the seam for a future scheduler with `triggerKind: "scheduled"`.

Memory entry points: `src/memory/board_swimlanes.ts`, `src/memory/board_cards.ts` (incl. `canEditCard` permission helper + sparse-position midpoint logic in `moveCard`), `src/memory/board_runs.ts`. HTTP routes live in `src/server/board_routes.ts`, mounted before the generic project routes in `routes.ts:handleApi`. Two new SSE event types (`card_run_started`, `card_run_finished`) are added to the shared `src/agent/sse_events.ts` so the frontend type-union picks them up automatically.

Permissions: board-view = `canSeeProject`; swimlane CRUD = admin or `projects.created_by`; card-create = any project viewer; card patch/move/archive/run = `canEditCard` (admin / project-owner / creator / user-assignee).

**Agent tools.** `src/tools/board.ts:makeBoardTools` returns six closure-bound tools (`board_list`, `board_get_card`, `board_create_card`, `board_update_card`, `board_move_card`, `board_archive_card`) — same closure pattern as `call_agent`, project + db + userId baked in so an agent in project "alpha" cannot reach project "beta". Spliced into the per-run registry by `buildRunRegistry` in `src/agent/loop.ts`. An agent inheriting all tools (no `tools = [...]` whitelist) gets every board tool by default; a whitelist filters them like any other tool name. Listed in `BOARD_TOOL_NAMES` and surfaced via `/api/tools` so the agent-picker UI shows them.

Web UI: "Board" tab between Messages and Whiteboard. Drag-and-drop via `@dnd-kit/core` + `@dnd-kit/sortable` (PointerSensor with `distance: 5` so in-card buttons keep working). `BoardTab` does optimistic state updates and rolls back on a 4xx. The card edit dialog hosts the **Run** button + a `CardRunLog` that streams the live run via `streamCardRun` and renders historical runs with an "Open in Chat" deep-link to each run's session. See [ADR 0010](./docs/adr/0010-project-boards.md).

**Auto-run.** Swimlanes and cards each carry an `auto_run` flag. A card's flag defaults ON the moment an agent assignee is set; a lane's flag is toggled from the column header. The scheduler's built-in `board.auto_run_scan` system-task (see Scheduler) joins both and launches `runCard` with `triggerKind: "scheduled"` for every hit, atomically clearing the card flag via `clearAutoRun` so a given reservation fires exactly once even under concurrent ticks. `GET /api/projects/:p/board` enriches each card DTO with a computed `latestRunStatus`, so the UI splits cards into *pending* / *running* / *answered* / *errored* / *idle*.

### Workspaces

Per-project file area under `<projectDir>/workspace/`, seeded with `input/` and `output/` by `ensureProjectDir` (idempotent backfill for legacy projects). Filesystem primitives live in `src/memory/workspace_fs.ts` (`listWorkspace`, `readWorkspaceFile`, `writeWorkspaceFile`, `mkdirWorkspace`, `moveWorkspaceEntry`, `deleteWorkspaceEntry`, `resolveForDownload`). Every path flows through `safeWorkspacePath`, which rejects absolute paths, `..`-traversal, and symlink escapes. `input/` and `output/` are **protected roots** — delete/move on those roots refuses; their contents are freely editable.

**Agent tools** (`src/tools/workspace.ts`, names in `WORKSPACE_TOOL_NAMES`): `list_workspace_files`, `read_workspace_file`, `write_workspace_file`. Same closure pattern as board tools — spliced into the per-run registry by `buildRunRegistry` in `src/agent/loop.ts`; whitelists work identically. Both read + write accept `encoding: "utf8"` (default) or `"base64"` for binaries. Reads are capped (64 KB utf8 / 5 MB base64) and signal `truncated: true` with `returnedBytes` / `totalBytes` so the LLM can handle overflow.

**HTTP** (`src/server/workspace_routes.ts`, mounted between board and scheduled-task routes): `GET /api/projects/:p/workspace/list?path=…`, `GET …/workspace/file?path=…&encoding=utf8|base64|raw`, `POST …/workspace/file` (JSON or multipart, 100 MB cap), `POST …/workspace/mkdir`, `POST …/workspace/move`, `DELETE /api/projects/:p/workspace?path=…`. Reads = `canSeeProject`, mutations = `canEditProject`.

Web UI: **Files** tab between Documents and Tasks. Breadcrumb nav, drag-and-drop upload zone, inline rename/mkdir/delete, lock icon on `input`/`output` roots. Downloads are plain `<a href>` to the `encoding=raw` endpoint. See [ADR 0012](./docs/adr/0012-project-workspaces.md).

### Web Tools

Three closure-bound agent tools for internet access (`src/tools/web.ts`, names in `WEB_TOOL_NAMES`): `web_fetch`, `web_search`, `web_download`. Same factory pattern as workspace/board tools — project + `WebConfig` baked into closures, spliced into the per-run registry by `buildRunRegistry` in `src/agent/loop.ts`.

- **`web_fetch(url)`** — fetches a URL, strips scripts/styles/nav/footer, converts to markdown via `node-html-markdown`. Output capped at 100 KB. Returns `{ url, title, content, truncated }`.
- **`web_search(query, max_results?)`** — searches the internet. Uses a SERP API (serper.dev) when `[web] serp_api_key` is configured in `bunny.config.toml` (or `SERP_API_KEY` env var); falls back to DuckDuckGo HTML scraping with retry logic (5 attempts, exponential backoff), then Bing as a second fallback, when no key is set. Returns `{ query, results: [{ title, url, snippet }], source }`.
- **`web_download(url, path)`** — downloads a file to the project workspace via `writeWorkspaceFile`. Max 100 MB. Returns `{ url, path, size }`.

Config section: `[web]` in `bunny.config.toml` (`serp_api_key`, `serp_provider`, `serp_base_url`, `user_agent`). `WebConfig` interface in `src/config.ts`. Env override: `SERP_API_KEY`. The `parseDuckDuckGoResults` helper is exported for testability. See [ADR 0018](./docs/adr/0018-web-tools.md).

### Whiteboards

Per-project Excalidraw whiteboards for visual collaboration. Each project can have multiple named whiteboards stored in the `whiteboards` table (elements JSON + thumbnail). Entry point: `src/memory/whiteboards.ts` (CRUD + `canEditWhiteboard`). Routes: `src/server/whiteboard_routes.ts` (mounted between board and workspace routes in `routes.ts`).

Two LLM interaction modes:
- **Edit mode** (`POST /api/whiteboards/:id/edit`): uses `runAgent` with `systemPromptOverride` to modify whiteboard elements via natural language. The session is hidden from Chat/Messages via `session_visibility`. Frontend extracts JSON from the response and updates the canvas.
- **Question mode** (`POST /api/whiteboards/:id/ask`): saves the whiteboard, creates a chat session with the PNG as an attachment, returns `{ sessionId }` for navigation to the Chat tab.

Web UI: **Whiteboard** tab between Board and Documents. Left sidebar lists saved whiteboards with thumbnails, center has the Excalidraw canvas with fullscreen toggle, bottom has a composer with edit/question mode toggle. Auto-saves on changes (debounced 2s). Thumbnails generated client-side via `exportToBlob`. Frontend dependency: `@excalidraw/excalidraw`. See [ADR 0015](./docs/adr/0015-whiteboards.md).

### Documents

Per-project rich-text documents stored as markdown. The `documents` table (`id`, `project`, `name`, `content_md`, `thumbnail`, `created_by`, timestamps; `UNIQUE(project, name)`) is project-scoped like whiteboards. Entry point: `src/memory/documents.ts` (CRUD + `canEditDocument`). Routes: `src/server/document_routes.ts` (mounted between whiteboard and workspace routes in `routes.ts`).

The WYSIWYG editor uses Tiptap (ProseMirror-based) with `tiptap-markdown` for round-trip serialization. A Word-style ribbon toolbar (`DocumentRibbon.tsx`) provides formatting controls. A subtle toggle switches between WYSIWYG and raw markdown/code mode.

Two LLM interaction modes (same pattern as whiteboards):
- **Edit mode** (`POST /api/documents/:id/edit`): uses `runAgent` with `systemPromptOverride` to modify document content. Frontend extracts markdown from the response and updates the editor.
- **Question mode** (`POST /api/documents/:id/ask`): creates a chat session with document content + question, returns `{ sessionId }` for navigation to Chat tab.

Additional features:
- **Image support**: drag & drop or paste images into the editor. Images are uploaded via `POST /api/documents/:id/images` (multipart) and stored in the project workspace at `documents/<docId>/images/<uuid>.<ext>`, served by the existing workspace file endpoint. Images are selectable with an accent outline.
- **Whiteboard embeds**: insert whiteboards from the current project via a picker dialog. Two modes: **live** (re-fetches latest thumbnail on render) and **static** (snapshot at insert time). Custom Tiptap node `whiteboardEmbed` in `web/src/components/tiptap/WhiteboardEmbedNode.tsx`.
- **Export**: Word (.docx) via `POST /api/documents/:id/export/docx` (server-side using `docx` npm package), HTML zip via `POST /api/documents/:id/export/html` (using `jszip`), PDF via `window.print()` with a print stylesheet. Export dropdown in the ribbon toolbar.
- **Templates**: `POST /api/documents/:id/save-as-template` saves a document as a reusable template.

Web UI: **Documents** tab between Whiteboard and Files. Left sidebar lists saved documents, center has the Tiptap WYSIWYG editor with Word ribbon toolbar (formatting, headings, lists, alignment, tables, images, whiteboard embeds, export), bottom has a composer with edit/question mode toggle. WYSIWYG/Code mode toggle in the ribbon. Auto-saves on changes (debounced). Frontend dependencies: `@tiptap/react`, `@tiptap/starter-kit`, various `@tiptap/extension-*`, `tiptap-markdown`. See [ADR 0016](./docs/adr/0016-documents.md).

### Contacts

Per-project contact management with groups. Three tables: `contacts` (per-project, JSON arrays for `emails`/`phones`/`tags`, data URL `avatar`), `contact_groups` (per-project, `UNIQUE(project, name)`, optional `color`), and `contact_group_members` (many-to-many join). Entry point: `src/memory/contacts.ts` (CRUD + groups + bulk import + vCard export). Routes: `src/server/contact_routes.ts` (mounted between document and workspace routes in `routes.ts`).

Import: client-side vCard parser in `web/src/lib/vcard.ts` (no deps, handles vCard 2.1/3.0/4.0 basics). Import dialog with drag-and-drop zone + preview table. Contact Picker API button shown on Android Chrome (feature-detected). Export: server-side vCard 3.0 generation, single or bulk.

Two LLM interaction modes (same pattern as documents/whiteboards):
- **Edit mode** (`POST /api/projects/:p/contacts/edit`): uses `runAgent` with `systemPromptOverride` to analyze/organize contacts. Session hidden from Chat via `session_visibility`.
- **Question mode** (`POST /api/projects/:p/contacts/ask`): creates a chat session with contacts summary, returns `{ sessionId }` for navigation to Chat tab.

Web UI: **Contacts** tab between Documents and Files. Sidebar lists contact groups with color dots and member counts; main area has a search bar (debounced 300ms), toolbar (New Contact / Import / Export), and a card grid with luxurious contact cards (gradient avatar circles, hover lift animation). Composer at bottom with edit/question mode toggle. HTTP: `GET/POST /api/projects/:p/contacts`, `GET/PATCH/DELETE /api/projects/:p/contacts/:id`, `POST .../contacts/import`, `GET .../contacts/:id/vcf`, `POST .../contacts/export`, `GET/POST /api/projects/:p/contact-groups`, `PATCH/DELETE .../contact-groups/:id`. See [ADR 0019](./docs/adr/0019-contacts.md).

### Scheduler

Generic periodic-task subsystem in `src/scheduler/`, seeded from `src/server/index.ts`. The `scheduled_tasks` table is the single source of truth (`kind = 'system' | 'user'`, `handler`, `cron_expr`, `payload`, `enabled`, `owner_user_id`, `next_run_at`, timestamps + last-result fields). A `HandlerRegistry` maps handler names to callbacks — domain modules register themselves, the scheduler knows nothing about boards/agents. The ticker runs once per minute (`src/scheduler/ticker.ts`), atomically claims due rows via `claimDueTasks` (bumps `next_run_at` by one minute in the same transaction), invokes the handler, and stores `setTaskResult` with the real `computeNextRun(cron, now)`. Malformed cron expressions park the row one hour out instead of crashing the tick.

The first system-handler is `board.auto_run_scan` (registered from `src/board/auto_run_handler.ts`; seeded with cron `*/5 * * * *`). HTTP surface: `GET/POST /api/tasks`, `GET/PATCH/DELETE /api/tasks/:id`, `POST /api/tasks/:id/run-now`, `GET /api/tasks/handlers`. System-tasks are visible to everyone but only admins can create/modify/toggle them; user-tasks are owned by their creator (admins see all). Web UI: the **Tasks** tab surfaces system vs user tasks with toggle/run-now/edit. See [ADR 0011](./docs/adr/0011-scheduled-tasks.md).

### Auth

Authentication lives in `src/auth/` (`users.ts`, `sessions.ts`, `apikeys.ts`, `password.ts`, `seed.ts`). Passwords are hashed with `Bun.password` (argon2id). `src/server/auth_middleware.ts:authenticate` tries `Authorization: Bearer bny_…` (API key) before the `bunny_session` HTTP-only cookie; routes in `src/server/auth_routes.ts` own `/api/auth/*`, `/api/users*`, `/api/apikeys*`. The other `/api/*` routes now require `authenticate` to succeed and stamp `user_id` on every `insertMessage` / event via `RunAgentOptions.userId`. On boot the server seeds an admin (from `cfg.auth.defaultAdmin*`) plus a `system` user used by the CLI when no `BUNNY_API_KEY` is provided. Non-admins only see their own sessions in `listSessions` / `/api/sessions/:id/messages`.

### Portable binary with embedded UI

`bun run build` (via `scripts/build.ts`) does: run `vite build` in `web/` (skippable with `--no-web`), walk `web/dist/`, generate `src/server/web_bundle.ts` with `import … with { type: "file" }` entries keyed by URL pathname, compile the binary with `bun build --compile` for all platforms, build the Tauri desktop client if `client/src-tauri` exists (skippable with `--no-client`), then restore the stub. At runtime `startServer` prefers a filesystem `web/dist/` adjacent to the cwd, falls back to `webBundle` (embedded), and finally to a dev-placeholder HTML page. The stub must stay checked in so `bun test` / dev runs compile without a prior web build.

### Desktop Client (Tauri)

A lightweight Tauri v2 desktop app under `client/` that wraps the server's web UI in a native window. It does **not** embed the server — it connects to a running Bunny instance. On first launch a local setup page asks for the server URL; after saving, subsequent launches navigate directly. The URL is persisted via `tauri-plugin-store` in OS-appropriate app data. A "File → Reset Connection" menu item clears the stored URL and returns to setup.

Structure: `client/package.json` (Tauri CLI + API deps), `client/ui/` (static setup page — no bundler), `client/src-tauri/` (Rust side: `lib.rs` with store plugin + menu, `tauri.conf.json` with `withGlobalTauri: true` and `csp: null` for remote content). Builds natively per platform via `bun run client:build`. See [ADR 0017](./docs/adr/0017-tauri-client.md).

## Conventions

- **TOML over YAML** for config; `.env` only for secrets.
- **English only, always.** Every artefact written to the repo or to GitHub must be in English — no Dutch, no mixed language. This is non-negotiable and applies to:
  - commit messages and commit bodies (including any trailers)
  - PR titles, PR descriptions, and PR/issue comments
  - all Markdown (`README.md`, `CLAUDE.md`, `docs/**`, ADRs)
  - code identifiers, code comments, log strings, error messages
  - test names and test descriptions
  - TOML/JSON `description` fields and seeded sample data
  Chat replies to the user may follow the user's language (e.g. Dutch) — but everything that lands in `git log`, the file tree, or GitHub does not. If you catch yourself typing Dutch in any of the above, stop and rewrite in English before committing.
- When changing `src/memory/schema.sql`, add new columns rather than altering existing ones — the schema is append-only because state is long-lived in `$BUNNY_HOME`.
- **Every HTTP mutation must log through the queue.** Add `void ctx.queue.log({ topic, kind, userId, data })` after each successful write. Use consistent naming: `topic` = domain noun (`project`, `board`, `auth`, `agent`, `task`, `workspace`, `apikey`, `user`, `session`), `kind` = verb or dotted verb (`create`, `update`, `delete`, `card.move`, `login.failed`, etc.). Always include `userId` when an authenticated user is available. Never log secrets (passwords, API key values). The queue is fire-and-forget (`void`) — logging must never block the response.
- Provider-specific streaming quirks belong in `src/llm/profiles.ts`, not in `adapter.ts` or `stream.ts`.
- Tests live under `tests/` mirroring `src/` layout. DB tests use `mkdtempSync` + `openDb(path)` for isolation.
- Design decisions are captured in `docs/adr/` (numbered). Add a new ADR when making a non-trivial architectural choice.
- **Visual language is canonised in `docs/styleguide.md`.** Consult it before adding UI (tokens, spacing scale, icon system via `lucide-react` + `web/src/lib/icons.ts`, rabbit mascot placements, shared primitives). When shipping UI changes that affect the styleguide — new tokens, new components, new icon usage — update the styleguide in the same PR and add a dated entry to its change log.
- **Before every commit**: verify that tests and docs still match reality.
  - Run `bun test` — any broken or newly-uncovered module must get a test in `tests/` mirroring the source path.
  - Update `README.md` if the user-facing workflow changed (new commands, new flags, new runtime requirements).
  - Update `docs/README.md` and add/amend an ADR in `docs/adr/` for non-trivial architectural changes.
  - Update this `CLAUDE.md` when conventions, build steps, or the high-level architecture shift.
  - Do not commit if tests regress or if a user-visible change has no accompanying doc update — fix first, commit after.
