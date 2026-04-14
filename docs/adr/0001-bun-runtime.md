# ADR 0001 — Bun als runtime

**Status:** Accepted
**Datum:** 2026-04-14

## Context

Bunny heeft een JavaScript-runtime nodig met native TypeScript-executie, ingebouwde SQLite, goede `fetch`/SSE support, en een snelle test-runner. Alternatieven: Node.js (met tsx/tsc), Deno, Bun.

## Beslissing

Bun (≥ 1.3.0) is de enige ondersteunde runtime.

## Onderbouwing

- **Native TS**: geen build-stap voor dev of productie; `bun run src/index.ts` werkt direct.
- **`bun:sqlite`**: ingebouwd, FTS5 beschikbaar, `loadExtension()` voor `sqlite-vec`. Geen native bindings compileren.
- **`bun:test`**: snelle test-runner met Jest-compatibele API; geen extra dep.
- **`Bun.serve`**: triviaal om een mock-LLM-server voor tests te spinnen die SSE-chunks streamt.
- **`Bun.TOML`**: ingebouwde TOML-parser voor `bunny.config.toml` — past bij user-voorkeur voor TOML boven YAML.
- **Binaire distributie**: `bun build --compile` voor later (één binary voor Mac/Linux/Windows) sluit aan op portability-doel.
- **Ecosysteem**: `bunqueue` is Bun-native; Node-compat zou onnodige friction geven.

## Consequenties

- Contributors moeten Bun installeren. Documenteer in README.
- Node-only libraries die `fs.promises` APIs assumen werken doorgaans, maar C-native Node-addons niet — vermijd die.
- CI draait op Bun's official GitHub Action.

## Alternatieven verworpen

- **Node.js + tsx**: extra build/tooling-laag, tragere test-runner, geen ingebouwde SQLite.
- **Deno**: uitstekende runtime maar zwakker ecosysteem; `bunqueue` is Bun-specifiek.
