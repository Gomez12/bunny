# Bunny

A Bun-native AI agent. Minimal architecture, queue-backed logging, hybrid memory (BM25 + vector) from day one.

## Status

Fase 1 (MVP) — in ontwikkeling. Zie [`docs/README.md`](./docs/README.md) voor architectuur en [`docs/adr/`](./docs/adr/) voor design-beslissingen.

## Quick start

```sh
bun install
cp .env.example .env     # fill LLM_API_KEY
bun run src/index.ts "list the files in src/"
```

State komt in `./.bunny/` (override met `BUNNY_HOME`). Database is SQLite, alles is portable.

## Web UI

Bunny heeft ook een tab-based web-UI: **Chat** (live streaming) en **Messages** (alle eerdere sessies uit SQLite, doorzoekbaar via BM25).

```sh
# terminal 1 — backend (Bun HTTP + SSE)
bun run serve                       # of: bun run src/index.ts serve

# terminal 2 — frontend (Vite dev server, proxy naar :3000)
cd web && bun install && bun run dev
# open http://localhost:5173
```

Voor productie: `bun run web:build` bouwt `web/dist/`, daarna serveert `bun run serve` zowel de API als de statische bundle op één poort.

Voor een portable binary met **alles erin** (CLI + server + embedded web-UI):

```sh
bun run build                        # bouwt web/dist en compileert voor alle platforms
# of één platform:
bun run build:platform darwin-arm64
./dist/bunny-darwin-arm64 serve      # UI op http://localhost:3000
```

De Vite-bundle wordt bij `build` als `import … with { type: "file" }` in het binary geëmbed via een gegenereerde manifest (`src/server/web_bundle.ts`); de stub wordt na de compile weer teruggezet zodat git schoon blijft.

Zie [`docs/adr/0006-web-ui.md`](./docs/adr/0006-web-ui.md) voor de architectuurkeuzes.

## Development

```sh
bun test          # unit + integration
bun run typecheck
bun run docs      # generate TypeDoc → docs/api/
```
