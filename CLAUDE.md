# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
bun install                    # install backend deps
cd web && bun install          # install frontend deps (separate package.json)

# Run the CLI (single turn)
bun run src/index.ts "<prompt>"
bun run src/index.ts --session <id> --hide-reasoning "<prompt>"

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

**State location:** everything lands in `./.bunny/` relative to cwd (override via `$BUNNY_HOME`). Portable by design — no `$HOME/.config`. API keys come from env (`LLM_API_KEY`, `EMBED_API_KEY`); see `.env.example`. Project-level choices go in `bunny.config.toml`.

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

`messages` rows are one-per-semantic-unit: separate rows for `content`, `reasoning`, `tool_result` via the `channel` column. The FTS virtual table is synced via triggers on `channel='content'` only.

### Web UI

`bunny serve` starts `Bun.serve` (`src/server/index.ts`) which:
- Routes `/api/*` through `src/server/routes.ts` (plain switch on pathname, no framework).
- Serves `web/dist/` statically if it exists; otherwise shows a dev placeholder pointing at the Vite dev server.
- Sets `idleTimeout: 0` — SSE streams can outlive the default timeout.

The frontend (`web/`) is React + Vite with its own `package.json`. Two tabs: Chat (live SSE streaming via `fetch` body-reader, not `EventSource`, because we POST JSON) and Messages (sessions listed via `listSessions()`, BM25-filtered when `q` is set). Session id is persisted in `localStorage` under `bunny.activeSessionId`.

SSE event shapes live in `src/agent/sse_events.ts` and are imported by both `src/agent/render_sse.ts` (backend) and `web/src/api.ts` (frontend) — single source of truth, compile-time drift guard. Vite's `server.fs.allow: [".."]` permits the cross-root import.

### Portable binary with embedded UI

`bun run build` (via `scripts/build.ts`) does: run `vite build` in `web/`, walk `web/dist/`, generate `src/server/web_bundle.ts` with `import … with { type: "file" }` entries keyed by URL pathname, compile the binary with `bun build --compile`, then restore the stub. At runtime `startServer` prefers a filesystem `web/dist/` adjacent to the cwd, falls back to `webBundle` (embedded), and finally to a dev-placeholder HTML page. The stub must stay checked in so `bun test` / dev runs compile without a prior web build.

## Conventions

- **TOML over YAML** for config; `.env` only for secrets.
- **Dutch** is fine in commit messages and prose; code identifiers stay English.
- When changing `src/memory/schema.sql`, add new columns rather than altering existing ones — the schema is append-only because state is long-lived in `$BUNNY_HOME`.
- Provider-specific streaming quirks belong in `src/llm/profiles.ts`, not in `adapter.ts` or `stream.ts`.
- Tests live under `tests/` mirroring `src/` layout. DB tests use `mkdtempSync` + `openDb(path)` for isolation.
- Design decisions are captured in `docs/adr/` (numbered). Add a new ADR when making a non-trivial architectural choice.
