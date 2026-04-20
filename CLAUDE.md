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
3. **Portable state** — single SQLite file under `$BUNNY_HOME`. Schema in `src/memory/schema.sql` (NEVER drop/rename columns — add new ones). Key tables: `messages`, `projects`, `agents`, `project_agents`, `skills`, `project_skills`, `board_swimlanes`, `board_cards`, `board_card_runs`, `scheduled_tasks`, `whiteboards`, `documents`, `contacts`, `contact_groups`, `contact_group_members`, `kb_definitions`, `code_projects`, `users`, `auth_sessions`, `api_keys`, `session_visibility`, `events`, `messages_fts` (FTS5). The `embeddings` vec0 table is created dynamically because the dimension must be baked into the CREATE statement.

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

The frontend (`web/`) is React + Vite with its own `package.json`. Navigation is a permanent **56 px left icon-rail** (`web/src/components/Sidebar.tsx`) that expands to 240 px on hover as an absolutely-positioned overlay (VS Code pattern — no layout reflow). Nav items are grouped into four sections: **Work** (Chat, Board, Tasks), **Content** (Documents, Whiteboard, Files, Code, Contacts, Knowledge Base, News), **Configure** (Workspace), **System** (Dashboard, Settings). Tabs that own a context column (Chat's `SessionSidebar`, `DocumentSidebar`, `WhiteboardSidebar`, contacts groups sidebar) keep that column inside the main area; other tabs fill the full width. Below 640 px the rail becomes a hamburger drawer. Icons come from `lucide-react` via the barrel at `web/src/lib/icons.ts` — don't import `lucide-react` directly, always go through the barrel. The rabbit mascot (`web/src/components/Rabbit.tsx`, SVG at `web/src/assets/rabbit.svg`) appears as the brand logo, a 0.04-opacity watermark anchored inside `.app-shell__main` (skipped on Dashboard via `.app-shell__main--dense`), empty-state illustrations via `<EmptyState>`, and the login/change-password hero. The visual language is canonised in **[docs/styleguide.md](./docs/styleguide.md)** — tokens, spacing scale, icon sanctioning, rabbit placements — always consult it before adding UI.

Tab behaviour: **Chat** (live SSE streaming via `fetch` body-reader, not `EventSource`, because we POST JSON; admins get a "Mine / All" scope toggle on the session sidebar, absorbing the former Messages tab; supports **Quick Chats** (per-user `is_quick_chat` flag on `session_visibility`, auto-hidden after 15 min by `session.hide_inactive_quick_chats`), **fork to Quick Chat** (copies non-trimmed history into a new session), per-bubble **edit / save+regenerate / fork** affordances, and **regenerate-as-alt-version** on assistant bubbles (chained via `messages.regen_of_message_id`, navigated via `< n/m >`); see [ADR 0023](./docs/adr/0023-chat-quick-chats-fork-edit-regen.md)). **Board** (per-project kanban — see Boards section). **Tasks** (scheduled tasks with cron — see Scheduler section). **Documents** (Tiptap WYSIWYG + LLM edit/question modes). **Whiteboard** (Excalidraw + LLM edit/question modes). **Files** (per-project workspace file browser). **Contacts** (per-project contact management with groups, search, vCard import/export). **Knowledge Base** (sub-tab shell; the first sub-tab is **Definitions** — per-project glossary with manual + LLM-generated short/long descriptions and sources — see Knowledge Base section). **Workspace** (inner sub-tabs for Projects / Agents / Skills — `web/src/tabs/WorkspaceTab.tsx`). **Dashboard** (KPIs, time-series charts, tool/agent/project breakdowns, error rates, scheduler health, and recent activity feed — powered by Recharts and a single `GET /api/dashboard?range=24h|7d|30d|90d|all` endpoint backed by `src/memory/stats.ts`; admin sees global stats, non-admin sees own data only). **Settings** (profile, API keys, admin-only Users and Logs sub-tabs).

The active tab is persisted in `localStorage` as `bunny.activeTab`; legacy values (`messages`, `logs`, `projects`, `agents`, `skills`) are aliased forward via `LEGACY_TAB_ALIAS` in `App.tsx`. Session id is persisted under `bunny.activeSessionId`, active project under `bunny.activeProject`. Switching project always starts a new session. The app boots by calling `GET /api/auth/me` — 401 drops the user on the login page, a `mustChangePassword` flag gates the forced-change page. All fetches use `credentials: "include"` so the `bunny_session` cookie rides along.

SSE event shapes live in `src/agent/sse_events.ts` and are imported by both `src/agent/render_sse.ts` (backend) and `web/src/api.ts` (frontend) — single source of truth, compile-time drift guard. Event types: `content`, `reasoning`, `tool_call`, `tool_result`, `usage`, `stats`, `error`, `turn_end`, `done`, `card_run_started`, `card_run_finished`, `kb_definition_generated`. Vite's `server.fs.allow: [".."]` permits the cross-root import.

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

### Interactive user questions (`ask_user`)

Lets the LLM pause mid-turn and ask the human a multiple-choice question, same pattern as Claude Code's `AskUserQuestion` in plan mode. The tool is closure-bound per run (`src/tools/ask_user.ts`, in `DYNAMIC_TOOL_NAMES`) — the handler emits an `ask_user_question` SSE event, registers a pending promise keyed by `sessionId::questionId` in `src/agent/ask_user_registry.ts`, and `await`s it; the user's answer is returned verbatim as the `tool_result`. Default timeout 15 min. The tool is **explicitly gated** via `RunAgentOptions.askUserEnabled` — only `POST /api/chat` and `POST /api/messages/:id/regenerate` flip it on, so document / whiteboard / KB / contact edit handlers, board card runs, and scheduler ticks never see it (their renderers have no way to surface the card, so a blocking call would silently hang). Answers post to `POST /api/sessions/:sessionId/questions/:questionId/answer` (mounted in `chat_routes.ts`), which resolves the in-memory waiter; 404 when stale. Web UI: `web/src/components/UserQuestionCard.tsx` renders a radio/checkbox card with inline-editable option text + optional free-form textarea, submission flips the card to read-only until the tool_result lands. `useSSEChat.Turn.userQuestions` stacks every active question on the live bubble. See [ADR 0026](./docs/adr/0026-ask-user-question-tool.md).

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

### Knowledge Base

Sub-tab shell under the **Knowledge Base** nav item. For v1 the only sub-tab is **Definitions** — a per-project dictionary of project-specific terminology. One table (`kb_definitions`, `UNIQUE(project, term)` with `term COLLATE NOCASE`) holds the row state: manual description, LLM-generated short + long + JSON sources, `llm_cleared` / `llm_status` / `llm_error` state machine, `is_project_dependent` flag, and a single-choice `active_description` ∈ `manual | short | long`. Entry point: `src/memory/kb_definitions.ts` (CRUD + `canEditDefinition`). Routes: `src/server/kb_routes.ts` (mounted between contact and workspace routes in `routes.ts`). Queue logging uses `topic: "kb"`.

Generation flow mirrors the document edit-mode pattern: `POST /api/projects/:p/kb/definitions/:id/generate` conditionally flips `llm_status` to `'generating'` (lost race → 409), creates a hidden `kb-def-<uuid>` session, and calls `runAgent` with a fixed `DEFINITION_SYSTEM_PROMPT` + `webCfg: ctx.cfg.web` (so `web_search` / `web_fetch` splice in automatically via `buildRunRegistry`). The model returns a single fenced JSON block (`{ shortDescription, longDescription, sources: [{title,url}] }`); `extractDefinitionJson` parses it, `setLlmResult` stores the values, and a custom `kb_definition_generated` SSE event signals success. A `try/catch/finally` wrapper guarantees the row never stays `generating` on a thrown path. **Project-dependent mode** blends the term with `projects.description` (falling back to the project name) before searching — e.g. in a project about cars the term "chair" is searched as "car seat", not bare "chair".

`llm_cleared` separates "never generated" (`0` + NULL fields) from "explicitly cleared" (`1` + NULL fields). A future scheduled task (`kb.definition.auto_fill`) can target the first set and skip the second. HTTP: `GET/POST /api/projects/:p/kb/definitions`, `GET/PATCH/DELETE /api/projects/:p/kb/definitions/:id`, `POST .../generate` (SSE), `POST .../clear-llm`, `POST .../active`. Web UI: `web/src/tabs/KnowledgeBaseTab.tsx` (sub-tab shell mirroring `WorkspaceTab`) + `web/src/tabs/kb/DefinitionsTab.tsx` (single-pane card grid) + `web/src/components/DefinitionDialog.tsx` (term + manual description + project-dependent checkbox + three read-only LLM panels with a radio group for the active description + Generate/Clear controls + live tool-call log during generation). See [ADR 0021](./docs/adr/0021-knowledge-base-definitions.md).

**SVG illustrations.** Each definition can carry a second, independent LLM-generated artifact: a professional SVG illustration. A parallel column set (`svg_content`, `svg_status`, `svg_error`, `svg_generated_at`) holds the state so illustration and text generation cannot collide; helpers `setSvgGenerating` / `setSvgResult` / `setSvgError` / `clearSvgFields` mirror the LLM state machine. `POST /api/projects/:p/kb/definitions/:id/generate-illustration` (SSE) runs `runAgent` with a fixed `ILLUSTRATION_SYSTEM_PROMPT` and **no `webCfg`** (pure generation — no web tools); the prompt embeds the term plus any filled short / long / manual descriptions with explicit labels. The model returns a fenced ` ```svg ` block; `extractSvgBlock` tolerates bare fences or a raw `<svg>…</svg>` match and caps payloads at 200 KB. On success a `kb_definition_illustration_generated` SSE event fires. `POST .../clear-illustration` wipes the stored SVG. The web UI renders the SVG via `<img src="data:image/svg+xml,${encodeURIComponent(svg)}">` both as a full-size panel inside `DefinitionDialog` and as a miniature thumbnail (`kb-card__illustration`) on each card — `<img>` context isolates any stray `<script>` in model output so no sanitizer dependency is needed. (The data URL uses no `;charset=…` / `;utf8` parameter; UTF-8 is the default for text MIME types, and bare `;utf8,` tokens are technically malformed under the RFC 2397 `name=value` grammar even though most browsers tolerate them.)

### Web News

Per-project periodic news aggregator. Each topic carries its own agent, a JSON `terms` list, an `update_cron`, an optional `renew_terms_cron` (or `always_regenerate_terms = 1`), and self-scheduling `next_update_at` / `next_renew_terms_at` timestamps. Two tables (`web_news_topics`, `web_news_items`) in `src/memory/schema.sql`. Items dedup per topic on `content_hash = sha256(normalizedUrl + normalizedTitle)` — a re-run that finds the same story bumps `seen_count` + `last_seen_at` via `upsertNewsItem`. Entry point: `src/memory/web_news.ts` (CRUD + `claimTopicForRun` / `releaseTopic` / `selectDueTopics` + `computeContentHash`).

**Scan handler** (same pattern as `board.auto_run_scan`): `web_news.auto_run_scan` ticks every minute, calls `selectDueTopics(db, now)` for any topic whose `next_update_at` *or* `next_renew_terms_at` has passed while idle + enabled, and dispatches `runTopic` with a per-tick concurrency cap (`MAX_CONCURRENT = 3`). Registered from `src/web_news/auto_run_handler.ts`; seeded from `src/server/index.ts` via `ensureSystemTask`.

**`runTopic`** (`src/web_news/run_topic.ts`) mirrors `runCard`: `claimTopicForRun` (race-safe via conditional UPDATE → 409 on lost race), decides renew-vs-fetch mode (renew iff `terms.length === 0 || alwaysRegenerateTerms || now >= nextRenewTermsAt`), opens a hidden `web-news-<uuid>` session, and calls `runAgent({ agent: topic.agent, webCfg: cfg.web, ... })` with a silent renderer and the task injected as the *user message* (preserving the agent's own system prompt + tool whitelist — web tools auto-splice via `buildRunRegistry`). The user message embeds the last 30 items as an explicit dedup list; the model returns one fenced JSON block with `items` (and, in renew mode, `improvedTerms`). `extractNewsJson` parses it, `upsertNewsItem` writes each item, `releaseTopic` flips back to idle and recomputes the next timestamps via `computeNextRun`. `try/catch/finally` guarantees the row never stays `running`.

HTTP: `GET/POST /api/projects/:p/news/topics`, `GET/PATCH/DELETE /api/projects/:p/news/topics/:id`, `POST .../topics/:id/run-now` (202 + detached), `POST .../topics/:id/regenerate-terms` (sets `next_renew_terms_at = 0`), `GET /api/projects/:p/news/items`, `DELETE /api/projects/:p/news/items/:id`. Mounted between kb-routes and workspace-routes. Queue logging uses `topic: "web_news"`. Web UI: **News** nav item in the Content section after Knowledge Base. `web/src/tabs/WebNewsTab.tsx` is a sidebar (topics + status dots + run-now / regen / edit / delete) + main pane (template renderer). Templates live under `web/src/components/news/` keyed by id in a local `TEMPLATES` map — **List** (chronological grid, topic badge per card) and **Newspaper** (masthead + per-topic sections). Add a template by writing one component + registering it; no touches to `WebNewsTab`. Template choice persisted to `localStorage['bunny.webNews.template']`. v1 polls every 5 s while any topic is running — SSE types `web_news_run_finished` / `web_news_topic_status` are reserved for a future project-scoped stream. See [ADR 0024](./docs/adr/0024-web-news.md).

### Multi-language translation

Per-project multi-language support: each project has a `languages` list + `default_language`; every entity (KB definition, document, contact `notes`, board card) is authored in one source language and machine-translated to the project's other languages by a scheduled task. Translations are read-only; only the source is editable.

- **Schema:** `projects.languages` (JSON array of ISO 639-1) + `default_language`; `users.preferred_language` (nullable, overrides project default on create + view); per-entity `original_lang` + `source_version`; four sidecar tables (`kb_definition_translations`, `document_translations`, `contact_translations`, `board_card_translations`) with `status ∈ {pending, translating, ready, error}`, `source_hash`, `translating_at`.
- **Shared abstraction** in `src/memory/translatable.ts`: one module emits CRUD + stale-marking + claim semantics; each memory module calls `registerKind({...})` on import. The KB/document/contact/card `create*` functions all end with `createTranslationSlots` so non-source-language sidecar rows exist the moment an entity is created. Every source-field edit path calls `markAllStale` — this is load-bearing; adding a fifth entity type without that call silently drops translations.
- **Language-expansion backfill.** When `updateProject` bumps `projects.languages`, it calls `backfillTranslationSlotsForProject` so every pre-existing entity gets pending sidecars for the newly-added languages — users no longer need to re-save entity-by-entity. `startServer` also calls `backfillAllTranslationSlots` at boot as a self-healer for legacy DBs where the translation feature landed on top of existing content. Both helpers are idempotent (`ON CONFLICT DO NOTHING`). `TranslatableKind.aliveFilter` (e.g. `"deleted_at IS NULL"` or `"archived_at IS NULL"`) keeps trashed / archived entities out of the pass so restore semantics stay clean.
- **Staleness is two-coordinate.** `entity.source_version` bumps on every source edit (cheap scheduler filter). Each sidecar stores `source_hash = sha256(sourceFields)` at translation time — on re-claim, if the hash matches the current source the handler short-circuits to `ready` without an LLM call (edit→revert is free).
- **Two system handlers.** `translation.auto_translate_scan` (cron `*/5 * * * *`, `src/translation/auto_translate_handler.ts`) claims pending sidecars, runs a fixed translation prompt via `runAgent` with a hidden session, parses fenced JSON, writes `setReady` / `setError`. `translation.sweep_stuck` (cron `0 3 * * *`, `src/translation/sweep_stuck_handler.ts`) reclaims rows stuck in `translating` for longer than `cfg.translation.stuckThresholdMs` (default 30 min). No boot-time sweep — a restart shouldn't silently retry background work.
- **KB short/long are translated, not regenerated.** All four KB source fields (term, manual_description, llm_short, llm_long) go through the same translation prompt so translations stay semantically locked to the source; re-running the KB-generation agent per language would produce divergent definitions. `llm_sources` stays on the entity row (URLs are language-neutral, not duplicated in sidecars).
- **HTTP:** `GET /api/projects/:p/translations/:kind/:id` (lists sidecar rows with `isOrphaned` computed), `POST .../translations/:kind/:id/:lang` (flips one row to pending and kicks the scheduler immediately via `runTask`). Mounted in `src/server/translation_routes.ts`, dispatched via `TRANSLATABLE_REGISTRY`. Config: `[translation]` block with `max_per_tick`, `max_document_bytes`, `stuck_threshold_ms`, `system_prompt`. Env: `TRANSLATION_MAX_PER_TICK`.
- **UI:** `web/src/components/TranslationsPanel.tsx` drops into every entity dialog — tabstrip (source-tab badged "Source", translation tabs read-only with status pill), 5 s polling while any row is transient, "Translate now" button. `web/src/lib/resolveActiveLang.ts` chooses the initial tab: `user.preferredLanguage` if supported → project default → entity original → first project language. `LanguageTabs`, `LangBadge`, `StatusPill` primitives live under `web/src/components/`. No project-scope SSE broadcast exists; polling is the v1 stand-in (the `translation_generated` SSE type is reserved for a future project-room abstraction).
- **Orphaned languages are soft-kept.** Removing a language from `project.languages` leaves sidecar rows in place; they read back as `isOrphaned=true`. Re-adding resurfaces them. Never hard-delete. See [ADR 0022](./docs/adr/0022-multi-language-translation.md).

### Scheduler

Generic periodic-task subsystem in `src/scheduler/`, seeded from `src/server/index.ts`. The `scheduled_tasks` table is the single source of truth (`kind = 'system' | 'user'`, `handler`, `cron_expr`, `payload`, `enabled`, `owner_user_id`, `next_run_at`, timestamps + last-result fields). A `HandlerRegistry` maps handler names to callbacks — domain modules register themselves, the scheduler knows nothing about boards/agents. The ticker runs once per minute (`src/scheduler/ticker.ts`), atomically claims due rows via `claimDueTasks` (bumps `next_run_at` by one minute in the same transaction), invokes the handler, and stores `setTaskResult` with the real `computeNextRun(cron, now)`. Malformed cron expressions park the row one hour out instead of crashing the tick.

The first system-handler is `board.auto_run_scan` (registered from `src/board/auto_run_handler.ts`; seeded with cron `*/5 * * * *`). HTTP surface: `GET/POST /api/tasks`, `GET/PATCH/DELETE /api/tasks/:id`, `POST /api/tasks/:id/run-now`, `GET /api/tasks/handlers`. System-tasks are visible to everyone but only admins can create/modify/toggle them; user-tasks are owned by their creator (admins see all). Web UI: the **Tasks** tab surfaces system vs user tasks with toggle/run-now/edit. See [ADR 0011](./docs/adr/0011-scheduled-tasks.md).

### Notifications

Per-user (cross-project) notifications. v1 trigger: `@username` mentions inside chat prompts; the subsystem is explicitly extension-ready so future triggers (`board.card_assigned`, `task.completed`, etc.) are a one-liner against `createNotification` + `fanout.publish`. One new table (`notifications`) in `src/memory/schema.sql` with `ON DELETE CASCADE` on the recipient and `actor_username` / `actor_display_name` denormalised so the panel survives actor deletion. The dispatcher prunes each user's list back to the newest 200 rows on every insert so the table stays bounded.

- **Scanner** (`src/notifications/mentions.ts:parseUserMentions`): walks the whole prompt (unlike the leading-only `src/agent/mention.ts`). Boundary rule excludes emails (`foo@bar.com`), URLs (`https://x.com/@alice`), path-like `folder/@user`, and mentions inside ```` ``` ```` blocks / inline `` ` `` spans. Results are deduped lower-case.
- **Dispatcher** (`dispatchMentionNotifications`): resolves each candidate via `getUserByUsernameCI`; skips unknown + self; for recipients who can see the project creates a `mention` row and publishes to the fanout; for recipients who cannot, aggregates a single `mention_blocked` counter-row for the sender listing all blocked usernames.
- **Gating** (`RunAgentOptions.mentionsEnabled`): only `POST /api/chat` flips this on. Regenerate, document / whiteboard / KB / contact edit handlers, board-card runs and every scheduler path leave it off, so re-runs and background work never produce duplicates. Mirrors `askUserEnabled` from ADR 0026.
- **Leading-@ collision fix**: `handleChat` only strips a leading `@name` when `getAgent(db, name)` actually returns a row. A username-only leading token flows through to the scanner so `@alice hi` (where alice is a user, not an agent) doesn't 404.
- **Fanout** (`src/notifications/fanout.ts`): in-memory `Map<userId, { subscribers, keepalive }>`. `subscribeUser` starts a 25 s `: ping\n\n` keepalive on first subscriber and drops the map entry when the last subscriber leaves. **No replay buffer** (differs from `RunFanout`) — long-lived streams would bloat the floor and new subscribers just call `GET /api/notifications` for history. Logout calls `closeAllFor(userId)`.
- **HTTP** (`src/server/notification_routes.ts`): `GET /api/notifications?unread=1&limit=&before=`, `PATCH /api/notifications/:id/read`, `POST /api/notifications/mark-all-read`, `DELETE /api/notifications/:id`, `GET /api/notifications/stream`. Mounted after translation routes and before the scheduler. Both mark-read routes publish `notification_read` back into the user's own fanout so other tabs decrement their badge live. Reading another user's notification returns 404 (not 403) — the row's existence stays private. Queue topic: `"notification"`.
- **SSE events** (`src/agent/sse_events.ts`): `notification_created` (embeds a `NotificationDto`) and `notification_read` (`ids: []` means mark-all-read).
- **Web UI**: `NotificationBell` (sidebar footer) + `ToastStack` (top-right) + a full tab at `web/src/tabs/NotificationsTab.tsx` (two-pane: list sidebar + detail pane, mirroring Documents/Whiteboard/Contacts). State is hoisted into `web/src/hooks/useNotifications.ts`. The bell sits in `.nav__user-row` (sibling to `.nav__user`) so its unread badge stays glanceable even with the rail collapsed; clicking it switches to the `notifications` tab — the earlier popover was getting clipped by the main content area. Toasts and OS pings are suppressed when the user is already viewing the target session, so pinging someone whose thread is already open doesn't double up. `osToast` feature-detects `window.__TAURI__` and routes to `@tauri-apps/plugin-notification` on desktop or `window.Notification` in the browser; permission is requested from the first bell click (user-gesture requirement). Deep links (`?tab=chat&project=…&session=…#m<id>`) are parsed on boot so external links or reloads jump directly to the referenced conversation.
- **Tauri**: `client/src-tauri/Cargo.toml` adds `tauri-plugin-notification`, registered in `lib.rs` with `notification:default` in the capabilities manifest.

See [ADR 0027](./docs/adr/0027-user-notifications.md).

### Telegram

Per-project Telegram bot integration — inbound DMs are forwarded to `runAgent` exactly like `/api/chat`, and outbound hooks mirror every `@mention` notification, `card_run_finished`, and Web News digest to the recipient's linked Telegram chat (if they have one for that project). Five new tables in `src/memory/schema.sql`: `project_telegram_config` (one row per project, `bot_token UNIQUE`, `transport ∈ {poll, webhook}`, `webhook_secret`, `last_update_id`, `poll_lease_until`), `user_telegram_links` (PK `(user_id, project)` + UNIQUE `(project, chat_id)` — linking is per-project because the bot is), `telegram_pending_links` (15-min TTL one-time pairing tokens), `telegram_seen_updates` (O(1) dedup swept every 24 h), and `web_news_topic_subscriptions` (opt-in Telegram digest subscribers per news topic; absent → topic creator only). See [ADR 0028](./docs/adr/0028-telegram-integration.md).

- **Inbound** (`src/telegram/handle_update.ts`): dedup via `markSeen` → advance `last_update_id` BEFORE processing (poison-message safety) → slash-command handling (`/start <token>`, `/new`, `/reset`, `/help`) → `chat_id → user_id` via `user_telegram_links` (unknown chat gets a canned "please link" reply) → per-chat mutex (`busy_until`, 5-min TTL) → rolling `current_session_id` → `runAgent({ askUserEnabled: false, mentionsEnabled: true })` with a `collectingRenderer` that buffers content deltas → format + chunk + send. v1 is DM-text only; `edited_message` / `channel_post` / `callback_query` / group chats log `message.inbound.unsupported` and reply politely.
- **Transport** (`src/telegram/poll_handler.ts`, `webhook_setup.ts`): short-polling is the default (handler `telegram.poll` registered from `src/server/index.ts`, cron `* * * * *`; each tick claims a 50 s `poll_lease_until`, calls `getUpdates?timeout=0`, releases the lease). Webhook mode is opt-in when `BUNNY_PUBLIC_BASE_URL` is set — `applyTransport` calls `setWebhook` / `deleteWebhook` on flip so `getUpdates` and webhook never collide (Bot API returns 409 otherwise). `reapplyAllTransports` runs at boot to self-heal registrations that drifted while the server was offline.
- **Outbound** (`src/telegram/outbound.ts:sendTelegramToUser`): silent no-op when the user has no link or the bot is disabled; otherwise runs through `decideFormat` (markdown → HTML subset via `src/telegram/format.ts`; HTML because MarkdownV2's escape rules are a footgun) + chunking at 4000 chars with `(n/m)` prefix + `sendDocument` fallback above 16 KB. Per-token rate limiter (`rate_limit.ts`, 30/s global + 1/s per chat) auto-paces bulk fan-out so 429s never reach production silently.
- **Hook points** (surgical, no new abstraction): `src/notifications/mentions.ts` takes an optional `telegramCfg` and pings the recipient after `createNotification` + `publish`; only `POST /api/chat` passes it via `RunAgentOptions.telegramCfg` (regenerate and every background path leave it off, same gating pattern as `askUserEnabled` / `mentionsEnabled`). `src/board/run_card.ts` pings `card.assigneeUserId` (or the trigger user for agent-assigned cards) after `markRunDone`; manual self-triggers skip, scheduled runs always ping. `src/web_news/run_topic.ts` pings each explicit subscriber (or the topic creator if none) after the run with a digest of the *actually inserted* items — a tick that only bumped `seen_count` is silent.
- **HTTP** (`src/server/telegram_routes.ts`): the public webhook endpoint `POST /api/telegram/webhook/:project` is mounted BEFORE the auth middleware in `routes.ts` (constant-time compare against `webhook_secret` via `crypto.timingSafeEqual`; always returns 200 so Telegram doesn't retry a deliberate reject; dispatch is detached so the handshake stays fast). Authenticated surface: `GET/PUT/DELETE /api/projects/:p/telegram` (admin or project creator only — the bot token is an impersonation capability; token is masked to last 4 chars on read, webhook secret is never returned), `POST .../telegram/regenerate-webhook-secret`, `POST .../telegram/test-send`, `GET/POST /api/me/telegram-links` + `DELETE /api/me/telegram-links/:project`, `GET/PUT /api/projects/:p/news/topics/:id/subscribers` + `POST/DELETE …/subscribers/:userId`.
- **Config** (`src/config.ts`): new `[telegram]` block (`poll_lease_ms`, `chunk_chars`, `document_fallback_bytes`, `public_base_url`). Env override: `BUNNY_PUBLIC_BASE_URL` (the only value an operator is likely to change per-environment).
- **Queue logging:** `topic: "telegram"`, kinds `config.create|update|delete`, `webhook.register|delete|receive|receive.ignored|receive.rejected|secret.rotate`, `poll.tick|error`, `message.inbound|inbound.unlinked|inbound.busy|inbound.unsupported|inbound.dropped`, `message.outbound`, `link.create.pending|create.confirm|create.failed|delete`, `session.reset`, `rate_limit`, `error`. Token values are never logged — only `tokenTail` (last 4 chars).
- **Web UI:** new **Integrations** sub-tab under Workspace (`web/src/tabs/IntegrationsTab.tsx`) with token input (password-masked), transport radio (webhook disabled when `BUNNY_PUBLIC_BASE_URL` is unset), enable toggle, webhook URL display + copy, regenerate-secret and disconnect buttons, and a test-send form. Settings → Profile gains a `TelegramLinkCard` (`web/src/components/TelegramLinkCard.tsx`) that lists existing per-project links and generates `https://t.me/<bot>?start=<token>` deep-links. Web News topic-subscriber UI is surfaced via the HTTP API in v1 only.

### Code (sub-application)

Per-Bunny-project source-code areas. Unlike the other Content entities, **Code** owns a *secondary icon rail* so future sub-features (reviews, docs generation, search, issues) can land without crowding the primary nav. When `activeTab === "code"`, `CodeTab` (`web/src/tabs/CodeTab.tsx`) renders `<CodeRail>` (`web/src/components/CodeRail.tsx`) immediately after the primary 56 px rail. The rail holds two pieces: (1) a **code-project picker** at the top — click to open `CodeProjectPickerDialog` (switch / add / edit / delete), label persists per Bunny project in `localStorage["bunny.activeCodeProject.<project>"]`; (2) a list of **per-project features** (v1: `Show Code`, `Chat`; future: `Code Review`, …), active feature persists in `localStorage["bunny.activeCodeFeature"]`. Feature buttons are disabled until a code project is picked.

- **Schema** (`src/memory/schema.sql`): one append-only table `code_projects` (`id`, `project`, `name`, `description`, `git_url`, `git_ref`, `git_status ∈ {idle|cloning|ready|error}`, `git_error`, `last_cloned_at`, `created_by`, timestamps, `deleted_at`/`deleted_by`, `UNIQUE(project, name)`).
- **Directory layout:** `<projectDir>/workspace/code/<name>/`. `WORKSPACE_DEFAULT_SUBDIRS` in `src/memory/project_assets.ts` has been widened from `["input", "output"]` to `["input", "output", "code"]`, so `code/` is a third protected workspace root automatically.
- **Cloning** (`src/code/clone.ts`): uses **`isomorphic-git`** rather than shelling out to a system `git` binary — preserves the portable-binary contract (`bun build --compile` bundles the library, no system toolchain required). Public repos only in v1: scheme validation at the route boundary rejects `ssh://`, `scp`-style `user@host:path`, `file://`, and `ext::`. Clone is fire-and-forget via the queue; bounded by `cfg.code.cloneTimeoutMs` (`AbortController`), `cfg.code.defaultCloneDepth`, and a post-clone `cfg.code.maxRepoSizeMb` size cap.
- **Memory module:** `src/memory/code_projects.ts` (CRUD + `canEditCodeProject` + `setGitCloning/Ready/Error/Idle` + `validateCodeProjectName` slug + `registerTrashable`).
- **HTTP** (`src/server/code_routes.ts`, mounted between contact_routes and kb_routes):
  - `GET/POST /api/projects/:p/code` (list / create — optional `{ gitUrl, gitRef }`)
  - `GET/PATCH/DELETE /api/code/:id` (name is immutable; soft-delete via the central trash)
  - `POST /api/code/:id/clone` (409 while `cloning`)
  - `GET /api/code/:id/tree?path=` + `GET /api/code/:id/file?path=&encoding=utf8|base64|raw` — thin adapters over `listWorkspace` / `readWorkspaceFile` / `resolveForDownload`. Paths in the response are stripped of the `code/<name>/` prefix so the UI sees paths relative to the code-project root.
  - `POST /api/code/:id/ask` — seeds a chat session with a `code.ask` prompt + top-level file listing, returns `{ sessionId }`; frontend navigates to Chat.
  - `POST /api/code/:id/edit` — SSE. Runs `runAgent` with `systemPromptOverride = resolvePrompt("code.edit")`; workspace + web tools are spliced automatically by `buildRunRegistry`. `askUserEnabled = false`, `mentionsEnabled = false`. Frontend refreshes the file tree on `done`.
  - `POST /api/code/:id/chat` — SSE, persistent. Drives the embedded Chat feature inside the Code tab. Body `{ sessionId?, prompt }`; when `sessionId` is omitted the handler mints one and returns it via `X-Session-Id`. Runs `runAgent` with `systemPromptOverride = resolvePrompt("code.chat", { codeProjectName, codeProjectPath, fileListing })` — workspace tools auto-spliced as above. Frontend persists the session id per code project in `localStorage["bunny.codeChatSession.<id>"]` so the conversation survives reloads.
  Every mutation logs through the queue (`topic: "code"`, kinds: `create|update|delete|clone.start|clone.success|clone.error|ask|edit|chat`).
- **Prompt registry** (ADR 0029): three new `projectOverridable` entries `code.ask`, `code.chat`, `code.edit`, variables `{{codeProjectName}}`, `{{codeProjectPath}}`, `{{fileListing}}`, plus `{{question}}` / `{{instruction}}` where applicable. Fixtures under `tests/prompts/fixtures/` guard the defaults.
- **Trash** (ADR 0025): `code_project` joins the trash kinds (`document`, `whiteboard`, `contact`, `kb_definition`). No translation sidecars (code is code, not natural language).
- **Config:** new `[code]` block (`clone_timeout_ms`, `max_repo_size_mb`, `default_clone_depth`).
- **Web UI:** `web/src/tabs/CodeTab.tsx` is the shell (state for active code project + active feature, mounts rail + picker dialog + create/edit dialog). `web/src/tabs/code/CodeShowCodeView.tsx` is the "Show Code" feature pane (header + Files/Details sub-tabs + quick-edit composer). `web/src/tabs/code/CodeChatView.tsx` is the "Chat" feature pane (persistent per-code-project chat with markdown rendering, read/write workspace tools via the same agent loop). `web/src/components/CodeRail.tsx` is the secondary 56 → 240 px rail with the project picker at the top and feature buttons below. `web/src/components/CodeProjectPickerDialog.tsx` and `CodeProjectDialog.tsx` are the two modals. `web/src/api.ts` carries the `CodeProject` type + helpers (`listCodeProjects`, `createCodeProject`, `patchCodeProject`, `deleteCodeProject`, `triggerCodeProjectClone`, `listCodeProjectTree`, `readCodeProjectFile`, `askCodeProject`, `editCodeProject`, `chatCodeProject`). CSS lives in `web/src/styles.css` under `.code-shell`, `.code-rail`, `.code-rail__picker`, `.code-picker`, `.code-view__*`, `.code-chat__*`.

See [ADR 0030](./docs/adr/0030-code-sub-application.md).

### Soft-delete and trash bin

Five entities can be soft-deleted from the user's UI: **documents**, **whiteboards**, **contacts**, **kb_definitions**, **code_projects**. Each carries `deleted_at INTEGER` + `deleted_by TEXT`; a non-null `deleted_at` means the row is in the Trash. Board cards use their own `archived_at` flow and stay out of scope. See [ADR 0025](./docs/adr/0025-soft-delete-and-trash.md).

- **Central module:** `src/memory/trash.ts` exposes `registerTrashable({ kind, table, nameColumn, hasUniqueName, translationSidecar*, reseedTranslations? })` + `softDelete`, `restore`, `hardDelete`, `listTrash`. Each entity module calls `registerTrashable` on import (same pattern as `registerKind` in `translatable.ts`). A fifth trashable entity is one `registerTrashable` call plus two new columns.
- **UNIQUE(project, name|term) collisions** are avoided by renaming the display column to `__trash:<id>:<original>` inside the soft-delete transaction. Restore strips the prefix; if another live row already uses the original name, restore returns `name_conflict` (HTTP 409) so the admin can resolve it.
- **Translation sidecars are dropped on soft-delete and reseeded on restore** (via the entity's `reseedTranslations` callback → `createTranslationSlots`). This keeps `translatable.ts` ignorant of trash and avoids the scheduler chasing ghost entities. Restore re-runs translations — acceptable since the source may have drifted.
- **Every list/get query carries `AND deleted_at IS NULL`.** The grep audit `FROM (documents|whiteboards|contacts|kb_definitions|code_projects)\b` should return zero hits without the predicate. A mangled `__trash:` name leaking into the UI is the canary if a query is ever added without the filter.
- **HTTP (admin-only, mounted before `/api/config/ui`):** `GET /api/trash`, `POST /api/trash/:kind/:id/restore`, `DELETE /api/trash/:kind/:id`. Routes live in `src/server/trash_routes.ts`. Queue logging uses `topic: "trash"`, `kind: "restore" | "hard_delete"`. Existing entity DELETE endpoints continue to work and now add `soft: true` to their queue log payload.
- **Web UI:** `SettingsPage` gains an admin-only **Trash** sub-tab (`web/src/tabs/TrashTab.tsx`) — a table with kind pill / name / project / deleted-at / deleted-by + *Restore* and *Delete forever* actions. The original DELETE buttons on Documents / Whiteboards / Contacts / Definitions are unchanged from the user's perspective; the item just moves into the bin instead of disappearing.

### Prompt registry

Every LLM prompt that used to live as a hardcoded template literal in a handler now goes through a central registry in `src/prompts/registry.ts` (13 entries: KB definition / illustration, document / whiteboard / contacts edit modes, Web News fetch + renew_terms, the three per-run tool descriptions, and the three `buildSystemMessage` fragments for peer-agents / skill-catalog / ask_user hints). Each entry declares `scope: "global" | "projectOverridable"`, `defaultText`, optional `{{name}}` template `variables`, and UI hints (`warnsJsonContract`, `warnsTokenCost`).

- **Resolver** (`src/prompts/resolve.ts`): `resolvePrompt(key, { project? })` walks project override → global override → registry default; `interpolate(template, vars)` substitutes `{{name}}` placeholders (unknown vars throw). Callers interpolate themselves so conditional composition (e.g. Web News concatenating `renew_terms` + `fetch`) stays explicit.
- **Global overrides** (`src/prompts/global_overrides.ts`): new `[prompts]` block in `bunny.config.toml`. Mtime-cached reader runs independently of `loadConfig` (which only runs once at startup) so admin PUTs take effect on the next LLM call without a restart. The writer strips + re-emits only the `[prompts]` section so every other block + its comments survive.
- **Per-project overrides** (`src/memory/prompt_overrides.ts`): lazy-seeded `prompts.toml` under `$BUNNY_HOME/projects/<name>/` — **sibling** of `systemprompt.toml`, not a subtable, so the mtime cache key stays clean and a prompt save never rewrites memory overrides. Both writers emit multi-line TOML on the same line as `"""` because Bun's TOML parser does not trim the newline-after-delimiter (contra the spec).
- **HTTP** (`src/server/prompt_routes.ts`, mounted before `/api/config/ui`): `GET/PUT /api/config/prompts` (admin only) + `GET/PUT /api/projects/:name/prompts` (admin or project creator). Body `{ key, text: string | null }`; `text: null` clears the override. Each PUT logs `{ topic: "prompts", kind: "global.set" | "project.set", data: { key, length, cleared } }`. 64 KiB upper bound per prompt.
- **UI**: admin-only **Settings → Prompts** sub-tab (`web/src/tabs/PromptsAdminTab.tsx`) lists every prompt grouped by namespace with textarea + Save + Reset + warning banners. Per-project overrides live in a new collapsible **Prompt overrides** section inside `ProjectDialog` (`web/src/components/ProjectPromptsSection.tsx`), lazy-loaded on first expand.
- **Drift guard**: every `defaultText` is frozen as a fixture file under `tests/prompts/fixtures/`; a snapshot test compares the two. Deliberate default edits require updating both the registry and the matching fixture, so drift shows up in review. See [ADR 0029](./docs/adr/0029-prompt-registry-and-two-tier-overrides.md).

### Auth

Authentication lives in `src/auth/` (`users.ts`, `sessions.ts`, `apikeys.ts`, `password.ts`, `seed.ts`). Passwords are hashed with `Bun.password` (argon2id). `src/server/auth_middleware.ts:authenticate` tries `Authorization: Bearer bny_…` (API key) before the `bunny_session` HTTP-only cookie; routes in `src/server/auth_routes.ts` own `/api/auth/*`, `/api/users*`, `/api/apikeys*`. The other `/api/*` routes now require `authenticate` to succeed and stamp `user_id` on every `insertMessage` / event via `RunAgentOptions.userId`. On boot the server seeds an admin (from `cfg.auth.defaultAdmin*`) plus a `system` user used by the CLI when no `BUNNY_API_KEY` is provided. Non-admins only see their own sessions in `listSessions` / `/api/sessions/:id/messages`.

### Portable binary with embedded UI

`bun run build` (via `scripts/build.ts`) does: run `vite build` in `web/` (skippable with `--no-web`), walk `web/dist/`, generate `src/server/web_bundle.ts` with `import … with { type: "file" }` entries keyed by URL pathname, compile the binary with `bun build --compile` for all platforms, build the Tauri desktop client if `client/src-tauri` exists (skippable with `--no-client`), then restore the stub. At runtime `startServer` prefers a filesystem `web/dist/` adjacent to the cwd, falls back to `webBundle` (embedded), and finally to a dev-placeholder HTML page. The stub must stay checked in so `bun test` / dev runs compile without a prior web build.

### Desktop Client (Tauri)

A lightweight Tauri v2 desktop app under `client/` that wraps the server's web UI in a native window. It does **not** embed the server — it connects to a running Bunny instance. On first launch a local setup page asks for the server URL; after saving, subsequent launches navigate directly. The URL is persisted via `tauri-plugin-store` in OS-appropriate app data. A "File → Reset Connection" menu item clears the stored URL and returns to setup.

Structure: `client/package.json` (Tauri CLI + API deps), `client/ui/` (static setup page — no bundler), `client/src-tauri/` (Rust side: `lib.rs` with store + opener plugins + menu, `tauri.conf.json` with `withGlobalTauri: true`, empty `windows` array, and `csp: null` for remote content). The main window is built programmatically in `setup()` so a `WebviewWindowBuilder::on_navigation` handler can intercept off-origin navigations and forward them to the system browser via `tauri-plugin-opener`; an injected initialization script rewrites `<a target="_blank">` clicks and `window.open(...)` calls to plain `window.location.href` so they pass through the same filter. Whitelist = saved server URL origin (scheme+host+port) + the local `tauri.localhost` origin. Builds natively per platform via `bun run client:build`. See [ADR 0017](./docs/adr/0017-tauri-client.md).

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
