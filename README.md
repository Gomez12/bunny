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

## Development

```sh
bun test          # unit + integration
bun run typecheck
bun run docs      # generate TypeDoc → docs/api/
```
