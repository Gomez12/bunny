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
bun run build                  # compile standalone binary via scripts/build.ts
```

**Runtime requirement:** Bun ≥ 1.3.0. Node is not supported — the project relies on `bun:sqlite`, `Bun.serve`, `Bun.TOML`, `bun:test`.

**State location:** everything lands in `./.bunny/` relative to cwd (override via `$BUNNY_HOME`). Portable by design — no `$HOME/.config`. LLM/embed API keys come from env (`LLM_API_KEY`, `EMBED_API_KEY`); user-facing API keys (`BUNNY_API_KEY` for the CLI) are minted per user via the web UI. Seeded-admin credentials can be overridden with `BUNNY_DEFAULT_ADMIN_PASSWORD`. Project-level choices go in `bunny.config.toml` (incl. `[auth]` block).

## Architecture

The agent loop is a thin outer/inner loop (Mihail Eric, _The Emperor Has No Clothes_). Three design principles drive the whole codebase:

1. **Minimal agent loop** — `src/agent/loop.ts:runAgent` is the only orchestrator: build system prompt (with hybrid recall injected) → stream LLM → if tool_calls, execute in parallel → repeat until assistant answers without tools. Capped at `MAX_TOOL_ITERATIONS = 20`.
2. **Queue is the spine** — every LLM request/response, tool call/result, and memory write is a fire-and-forget job on a `bunqueue` worker (`src/queue/`) which logs to `events` in SQLite. Nothing is invisible; nothing blocks the agent.
3. **Portable state** — single SQLite file under `$BUNNY_HOME`. Schema in `src/memory/schema.sql` (NEVER drop/rename columns — add new ones). The `embeddings` vec0 table is created dynamically because the dimension must be baked into the CREATE statement.

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

The frontend (`web/`) is React + Vite with its own `package.json`. Four tabs: Chat (live SSE streaming via `fetch` body-reader, not `EventSource`, because we POST JSON), Messages (sessions listed via `listSessions()`, BM25-filtered when `q` is set, scoped to the active project), Projects (card grid with click-to-switch + create/edit dialog) and Settings (profile, API keys, admin-only user management). Session id is persisted in `localStorage` under `bunny.activeSessionId`, active project under `bunny.activeProject`. Switching project always starts a new session. The app boots by calling `GET /api/auth/me` — 401 drops the user on the login page, a `mustChangePassword` flag gates the forced-change page. All fetches use `credentials: "include"` so the `bunny_session` cookie rides along.

SSE event shapes live in `src/agent/sse_events.ts` and are imported by both `src/agent/render_sse.ts` (backend) and `web/src/api.ts` (frontend) — single source of truth, compile-time drift guard. Vite's `server.fs.allow: [".."]` permits the cross-root import.

### Projects

Logical workspaces that group sessions/messages + on-disk assets. Source of truth for metadata lives in the `projects` table (name PK, description, visibility, created_by, timestamps); source of truth for the system prompt lives on disk at `$BUNNY_HOME/projects/<name>/systemprompt.toml` (`prompt`, `append`). Every `messages` row carries a `project` column; legacy NULL rows read back as `'general'` via `COALESCE(project, 'general')`. A session is locked to one project — `runAgent` errors on mismatch.

The **default project name** and the **base system prompt** both come from `[agent]` in `bunny.config.toml` (`default_project`, `system_prompt`) with env overrides `BUNNY_DEFAULT_PROJECT` / `BUNNY_SYSTEM_PROMPT`. `runAgent` takes them via `RunAgentOptions.agentCfg`; `buildSystemMessage` falls back to a hard-coded prompt only in tests. Both the CLI boot (`src/index.ts`) and `startServer` seed the configured default project at startup on top of the always-present `general` row.

Entry points: `src/memory/projects.ts` (CRUD + `validateProjectName` + `getSessionProject`), `src/memory/project_assets.ts` (`ensureProjectDir`, `loadProjectSystemPrompt`, `writeProjectSystemPrompt`). System-prompt composition happens in `src/agent/prompt.ts:buildSystemMessage` — `append=true` (default) concatenates after the base prompt, `append=false` replaces it. Recall (`hybridRecall`, `searchBM25`, `searchVector`) all accept a `project` filter so projects never leak into each other.

CLI: `--project <name>` auto-creates DB row + directory when missing. HTTP: `GET/POST /api/projects`, `GET/PATCH/DELETE /api/projects/:name`; `?project=<name>` on `/api/sessions`; optional `project` field on the `POST /api/chat` body. Web UI: fourth tab "Projects" shows cards, click-to-switch (starts a fresh session), + dialog for create/edit. Project name is immutable (PK + dir); only description, visibility, and system prompt can change. See [ADR 0008](./docs/adr/0008-projects.md).

### Agents

Named personalities with their own system prompt, tool whitelist and memory knobs. Orthogonal to Projects: the `agents` table + `$BUNNY_HOME/agents/<name>/config.toml` hold the definition, and a `project_agents(project, agent)` join controls **where** an agent is available. Entry points live at `src/memory/agents.ts` (CRUD + link helpers), `src/memory/agent_assets.ts` (TOML asset loader), and `src/tools/call_agent.ts` (subagent invocation tool).

- `runAgent` accepts `agent?: string` and a `callDepth?: number`; it resolves `loadAgentAssets(agent)`, merges memory knobs with precedence `agent → project → global`, filters the registry via `ToolRegistry.subset(filter, extras)`, and calls `buildSystemMessage` with the agent prompt (which wins over the project prompt via `append = false` by default). When `context_scope = "own"` the loop passes the agent's name as `ownAuthor` so `getRecentTurns` + `hybridRecall` filter recall to user turns + rows authored by this agent.
- `messages.author` stamps every assistant/reasoning/tool_call/tool_result row with the responding agent's name (`NULL` = default assistant). The column is append-only — never remove.
- `POST /api/chat` accepts an optional `agent` field; otherwise `parseMention` (`src/agent/mention.ts`) strips a leading `@name` off the prompt. A mention without a trailing prompt returns 400. The agent **replaces** the default assistant for that turn — there is no fallback or double-answer.
- Subagents: enable `is_subagent = true` on an agent, then add it to another agent's `allowed_subagents`. The orchestrator then receives the built-in `call_agent(name, prompt)` tool which spawns a nested `runAgent` with a silent renderer (final answer surfaces as the tool result); depth is capped by `MAX_AGENT_CALL_DEPTH = 2`.
- SSE events (`content`, `reasoning`, `tool_call`, `tool_result`, `turn_end`) carry an optional `author`. `createSseRenderer(sink, { author })` tags every outgoing event; the frontend `MessageBubble` renders `@name` in place of `assistant`. `HistoryTurn.author` propagates the same field from replayed DB rows so reload looks identical.
- HTTP: `GET/POST /api/agents`, `GET/PATCH/DELETE /api/agents/:name`, `GET/POST /api/projects/:name/agents`, `DELETE /api/projects/:name/agents/:agent`, `GET /api/tools` (for the picker). Web UI: fifth tab "Agents" with a card grid + dialog; per-card checkboxes to link/unlink to each project. See [ADR 0009](./docs/adr/0009-agents.md).

### Boards

Per-project Trello-style kanban with configurable swimlanes and cards. One board per project — `project` is the scope key on every row, no separate `boards` table (mirrors `project_agents`). Three append-only tables (`board_swimlanes`, `board_cards`, `board_card_runs`) live in `src/memory/schema.sql`. Sparse positions (steps of 100) make drag-and-drop reorders cheap. `createProject` seeds Todo/Doing/Done; `GET /api/projects/:p/board` backfills them on-demand for legacy projects.

Cards have a **mutually exclusive** assignee — `assignee_user_id` *or* `assignee_agent`, not both. Agent-assigned cards can be executed: `runCard` (`src/board/run_card.ts`) is the single entry point — it spawns `runAgent` detached, mirrors the streamed events into an in-memory **fanout** keyed by `runId`, and writes the final assistant answer to the run row via `markRunDone`. The fanout buffers everything so a late SSE subscriber on `/api/cards/:id/runs/:runId/stream` replays the whole run; after a 60s grace window post-close the fanout is dropped and clients fall back to `/api/sessions/:id/messages`. `trigger_kind = 'manual'` today; the same `runCard` function is the seam for a future scheduler with `triggerKind: "scheduled"`.

Memory entry points: `src/memory/board_swimlanes.ts`, `src/memory/board_cards.ts` (incl. `canEditCard` permission helper + sparse-position midpoint logic in `moveCard`), `src/memory/board_runs.ts`. HTTP routes live in `src/server/board_routes.ts`, mounted before the generic project routes in `routes.ts:handleApi`. Two new SSE event types (`card_run_started`, `card_run_finished`) are added to the shared `src/agent/sse_events.ts` so the frontend type-union picks them up automatically.

Permissions: board-view = `canSeeProject`; swimlane CRUD = admin or `projects.created_by`; card-create = any project viewer; card patch/move/archive/run = `canEditCard` (admin / project-owner / creator / user-assignee).

Web UI: tab "Board" between Messages and Projects. Drag-and-drop via `@dnd-kit/core` + `@dnd-kit/sortable` (PointerSensor with `distance: 5` so in-card buttons keep working). `BoardTab` does optimistic state updates and rolls back on a 4xx. The card edit dialog hosts the **Run** button + a `CardRunLog` that streams the live run via `streamCardRun` and renders historical runs with an "Open in Chat" deep-link to each run's session. See [ADR 0010](./docs/adr/0010-project-boards.md).

### Auth

Authentication lives in `src/auth/` (`users.ts`, `sessions.ts`, `apikeys.ts`, `password.ts`, `seed.ts`). Passwords are hashed with `Bun.password` (argon2id). `src/server/auth_middleware.ts:authenticate` tries `Authorization: Bearer bny_…` (API key) before the `bunny_session` HTTP-only cookie; routes in `src/server/auth_routes.ts` own `/api/auth/*`, `/api/users*`, `/api/apikeys*`. The other `/api/*` routes now require `authenticate` to succeed and stamp `user_id` on every `insertMessage` / event via `RunAgentOptions.userId`. On boot the server seeds an admin (from `cfg.auth.defaultAdmin*`) plus a `system` user used by the CLI when no `BUNNY_API_KEY` is provided. Non-admins only see their own sessions in `listSessions` / `/api/sessions/:id/messages`.

### Portable binary with embedded UI

`bun run build` (via `scripts/build.ts`) does: run `vite build` in `web/`, walk `web/dist/`, generate `src/server/web_bundle.ts` with `import … with { type: "file" }` entries keyed by URL pathname, compile the binary with `bun build --compile`, then restore the stub. At runtime `startServer` prefers a filesystem `web/dist/` adjacent to the cwd, falls back to `webBundle` (embedded), and finally to a dev-placeholder HTML page. The stub must stay checked in so `bun test` / dev runs compile without a prior web build.

## Conventions

- **TOML over YAML** for config; `.env` only for secrets.
- **Dutch** is fine in commit messages and prose; code identifiers stay English.
- When changing `src/memory/schema.sql`, add new columns rather than altering existing ones — the schema is append-only because state is long-lived in `$BUNNY_HOME`.
- Provider-specific streaming quirks belong in `src/llm/profiles.ts`, not in `adapter.ts` or `stream.ts`.
- Tests live under `tests/` mirroring `src/` layout. DB tests use `mkdtempSync` + `openDb(path)` for isolation.
- Design decisions are captured in `docs/adr/` (numbered). Add a new ADR when making a non-trivial architectural choice.
- **Before every commit**: verify that tests and docs still match reality.
  - Run `bun test` — any broken or newly-uncovered module must get a test in `tests/` mirroring the source path.
  - Update `README.md` if the user-facing workflow changed (new commands, new flags, new runtime requirements).
  - Update `docs/README.md` and add/amend an ADR in `docs/adr/` for non-trivial architectural changes.
  - Update this `CLAUDE.md` when conventions, build steps, or the high-level architecture shift.
  - Do not commit if tests regress or if a user-visible change has no accompanying doc update — fix first, commit after.
