# Architecture tour

A mental model in three principles, one data flow, and one code map. Spend 20 minutes here before touching anything.

## Three design principles

1. **Minimal agent loop.** `src/agent/loop.ts:runAgent` is the only orchestrator: build system prompt → stream LLM → execute tools in parallel → repeat until the model answers without tools. Hard cap `MAX_TOOL_ITERATIONS = 20`. Everything else is support scaffolding. See [ADR 0001](../../adr/0001-bun-runtime.md) and Mihail Eric's *The Emperor Has No Clothes*.
2. **Queue is the spine.** Every meaningful action is a fire-and-forget job on `bunqueue` (`src/queue/`) that writes to `events` in SQLite. This covers LLM requests, tool calls, memory writes, **and every HTTP mutation** (project/board/agent/task CRUD, auth events). Every route context carries `queue: BunnyQueue`. Nothing is invisible; nothing blocks the caller. See [ADR 0004](../../adr/0004-bunqueue-as-spine.md) and [`concepts/queue-and-logging.md`](../concepts/queue-and-logging.md).
3. **Portable state.** Single SQLite file under `$BUNNY_HOME`. No `$HOME/.config` fallback. A project directory is a complete, relocatable agent. See `concepts/projects-as-scope.md`.

## One turn, end-to-end

```
CLI / HTTP (/api/chat)
        │
        ▼
 runAgent(prompt)           ◄── src/agent/loop.ts
        │
        ├─► buildSystemMessage + hybridRecall + last_n replay
        │
        ▼
 LLM adapter.chat()         ◄── src/llm/adapter.ts
        │
        ├─► SSE delta stream:
        │     content     ─► render.onDelta      ─► UI / CLI
        │     reasoning   ─► render.onDelta      ─► dim italic / dropdown
        │     tool_call   ─► render.onDelta      ─► tool chip
        │
        ▼
 accumulated assistant message ─► insertMessage (+ FTS5 + vec0 embedding)
        │
        ▼
 tool_calls? ──► execute in parallel ─► insertMessage (tool_result rows)
        │                                        │
        └────────────────────────────────────────┘ loop until no tool calls
```

- Recall fuses BM25 (FTS5 trigram) + kNN (sqlite-vec) via Reciprocal Rank Fusion. Top-k (default 8) messages are spliced into the system prompt every turn. See `concepts/memory-and-recall.md`.
- Recent turns (`memory.last_n`, default 10) are replayed verbatim for short-term coherence. IDs are passed to recall via `excludeIds` so nothing duplicates.
- The `Renderer` interface (`src/agent/render.ts`) is transport-agnostic. CLI uses `createRenderer` (ANSI), web uses `createSseRenderer` (JSON over SSE). See `concepts/streaming-and-renderers.md`.

## Code map

### `src/` (backend)

```
src/
├── agent/         # runAgent, prompt building, SSE renderer, tool registry, mention parsing
├── auth/          # users, sessions, API keys, password hashing
├── board/         # runCard orchestrator, auto_run handler
├── config.ts      # bunny.config.toml loader + type
├── index.ts       # CLI entry point
├── llm/           # adapter, stream parser, provider profiles
├── memory/        # SQLite schema, messages, projects, every entity CRUD
│   └── schema.sql # canonical DDL (APPEND-ONLY)
├── notifications/ # mention scanner, dispatcher, fanout
├── paths.ts       # $BUNNY_HOME resolution
├── queue/         # bunqueue wrapper
├── scheduler/     # cron ticker, handler registry
├── server/        # Bun.serve, route switch, per-domain route modules
├── telegram/      # inbound/outbound bot integration
├── tools/         # agent-callable tools (static + closure-bound)
├── translation/   # auto-translate handler, sweep-stuck handler
├── types/
├── util/
└── web_news/      # topic runner, auto-scan handler
```

### `web/src/` (frontend)

```
web/src/
├── App.tsx              # tab router, boot-time /api/auth/me gate
├── api.ts               # fetch helpers + SseEvent import (cross-root via vite.config)
├── assets/
├── components/          # shared primitives (~45 files): Sidebar, MessageBubble, dialogs, …
│   └── tiptap/          # custom Tiptap nodes (WhiteboardEmbedNode, …)
├── hooks/               # useSSEChat, useNotifications, …
├── lib/
│   ├── icons.ts         # icon barrel — NEVER import lucide-react directly
│   ├── vcard.ts         # client-side vCard parser
│   └── resolveActiveLang.ts
├── main.tsx
├── pages/               # login / change-password shells
├── styles.css           # tokens + layout
└── tabs/                # one file per top-level tab (Chat, Board, Documents, …)
```

### Top-level extras

```
client/                  # Tauri wrapper (Rust + minimal HTML setup page)
docs/                    # this doc corpus (dev/, adr/, styleguide.md, tools.md, http-api.md)
scripts/build.ts         # compile standalone binary via bun build --compile
tests/                   # mirrors src/ layout
```

## Where the frontend plugs in

`bunny serve` launches `src/server/index.ts:startServer`. It:

1. Routes `/api/*` through `src/server/routes.ts` (plain switch, no framework).
2. Serves `web/dist/` statically if present, falls back to the embedded `webBundle`, else a dev placeholder pointing at Vite.
3. Sets `idleTimeout: 0` so long-lived SSE streams survive.

`createSseRenderer` (backend) and `web/src/api.ts` share the event type union in `src/agent/sse_events.ts` — compile-time drift guard. Adding a new event type is a compile error on both sides. Vite's `server.fs.allow: [".."]` permits the cross-root import.

## Where to go next

- [`first-change.md`](./first-change.md) — concrete walkthrough.
- [`conventions.md`](./conventions.md) — the rules before your first commit.
- [`../concepts/agent-loop.md`](../concepts/agent-loop.md) — drill into the loop.
