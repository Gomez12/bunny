# ADR 0006 — Web UI (Chat + Messages)

**Status:** Accepted
**Datum:** 2026-04-14

## Context

Bunny begon als CLI. Voor demoes en dagelijks gebruik wil de gebruiker een browser-UI met twee tabs:

- **Chat** — live streaming conversatie, zelfde agent loop als de CLI.
- **Messages** — alle eerdere sessies uit de `messages`-tabel, gegroepeerd en doorzoekbaar.

Eisen: geen tweede runtime, geen nieuwe database, de bestaande streaming pipeline en memory ongewijzigd.

## Beslissing

Eén extra Bun process (`bunny serve`) exposeert een REST + SSE API. De frontend is een React + Vite app in `web/`. In dev proxyt Vite `/api` naar `:3000`; in productie serveert `Bun.serve` de statische bundle uit `web/dist/`.

## Onderbouwing

- **Geen framework** in de backend: `Bun.serve` + plain switch op `pathname` houdt de laag minimaal. Routes delegeren naar bestaande modules (`runAgent`, `getMessagesBySession`, `searchBM25`).
- **React + Vite** in de frontend: de streaming UI heeft veel incrementele state (deltas, tool calls). Vanilla JS zou werken maar kost meer regels; Vite geeft HMR voor snelle iteratie op de UI.
- **Renderer-interface**: `src/agent/render.ts` expose een expliciete `Renderer`-interface. De CLI gebruikt `createRenderer` (ANSI), de webserver gebruikt `createSseRenderer` (JSON over SSE). De agent loop is transport-agnostisch.
- **SSE in plaats van WebSocket**: chat is één-richtings streaming. SSE past op `ReadableStream` met `Bun.serve`, werkt achter elke proxy, en de browser leest het via `fetch` + body-reader (geen `EventSource` — we willen POST-bodies sturen).
- **Session-identiteit in localStorage**: eenvoudig, geen auth nodig voor MVP. Session picker laat de gebruiker wisselen tussen sessies.
- **BM25 voor session-search**: hergebruikt de bestaande `messages_fts` trigram index; geen extra infrastructuur.

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

Messages-tab: `GET /api/sessions?q=...` → `listSessions()` (FTS5-filter als `q` gezet), `GET /api/sessions/:id/messages` → `getMessagesBySession()`.

## Consequenties

- Nieuwe directory `web/` met eigen `package.json` (alleen `react`, `react-dom`, `vite`, typings). Geen root-level React/Vite deps.
- `bunny serve` houdt de `bunqueue` worker open zoals de CLI dat doet — alle LLM/tool/memory events worden gelogd zoals altijd.
- SSE vereist `idleTimeout: 0` op `Bun.serve` zodat lange LLM-turns niet worden afgekapt.
- De frontend heeft geen eigen state-store; React state + `localStorage` voor `activeSessionId` is voldoende.

## Niet-doelen (voor nu)

- Auth / multi-user support.
- WebSocket upgrade voor bidirectionele interrupts (agent-abort gebeurt client-side via `AbortController`).
- Events-tab (raw queue audit trail) — kan later als derde tab zonder schema-wijziging.
