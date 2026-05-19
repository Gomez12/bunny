# ADR 0006 — Web UI (Chat + Messages)

**Status:** Accepted
**Date:** 2026-04-14

## Context

Bunny started as a CLI. For demos and daily use the user wants a browser UI with two tabs:

- **Chat** — live streaming conversation, same agent loop as the CLI.
- **Messages** — all previous sessions from the `messages` table, grouped and searchable.

Requirements: no second runtime, no new database, the existing streaming pipeline and memory unchanged.

## Decision

One extra Bun process (`bunny serve`) exposes a REST + SSE API. The frontend is a React + Vite app in `web/`. In dev, Vite proxies `/api` to `:3000`; in production `Bun.serve` serves the static bundle from `web/dist/`.

## Rationale

- **No framework** in the backend: `Bun.serve` + plain switch on `pathname` keeps the layer minimal. Routes delegate to existing modules (`runAgent`, `getMessagesBySession`, `searchBM25`).
- **React + Vite** in the frontend: the streaming UI has a lot of incremental state (deltas, tool calls). Vanilla JS would work but costs more lines; Vite gives HMR for fast iteration on the UI.
- **Renderer interface**: `src/agent/render.ts` exposes an explicit `Renderer` interface. The CLI uses `createRenderer` (ANSI), the webserver uses `createSseRenderer` (JSON over SSE). The agent loop is transport-agnostic.
- **SSE instead of WebSocket**: chat is one-directional streaming. SSE maps to `ReadableStream` with `Bun.serve`, works behind any proxy, and the browser reads it via `fetch` + body-reader (no `EventSource` — we want to send POST bodies).
- **Session identity in localStorage**: simple, no auth needed for MVP. A session picker lets the user switch between sessions.
- **BM25 for session search**: reuses the existing `messages_fts` trigram index; no extra infrastructure.

## Data-flow

```
Browser ──POST /api/chat {sessionId, prompt}──► Bun.serve
                                                   │
                                                   ▼
                                      runAgent(..., renderer=SseRenderer)
                                                   │
                                    each delta ─► SSE: "data: {json}\n\n"
                                                   │
                                              [done] event, stream closes
```

Messages tab: `GET /api/sessions?q=...` → `listSessions()` (FTS5 filter when `q` is set), `GET /api/sessions/:id/messages` → `getMessagesBySession()`.

## Consequences

- New `web/` directory with its own `package.json` (only `react`, `react-dom`, `vite`, typings). No root-level React/Vite deps.
- `bunny serve` keeps the `bunqueue` worker open as the CLI does — all LLM/tool/memory events are logged as always.
- SSE requires `idleTimeout: 0` on `Bun.serve` so long LLM turns are not cut off.
- The frontend has no state store of its own; React state + `localStorage` for `activeSessionId` is enough.

## Non-goals (for now)

- WebSocket upgrade for bidirectional interrupts (agent abort happens client-side via `AbortController`).

## Addendum (2026-04)

The UI has grown well beyond the original two-tab MVP. As of now it has thirteen tabs: Dashboard, Chat, Messages, Board, Whiteboard, Documents, Files, Tasks, Projects, Agents, Skills, Logs (admin-only), Settings. Auth and multi-user support shipped in [ADR 0007](./0007-auth-and-users.md). The events/audit trail is available as the admin-only Logs tab. Each major feature is documented in its own ADR (0008–0017). The core decisions from this ADR — no backend framework, React + Vite frontend, `Renderer` interface, SSE over WebSocket, BM25 for search — all remain in effect.
