# ADR 0001 — Bun as runtime

**Status:** Accepted
**Date:** 2026-04-14

## Context

Bunny needs a JavaScript runtime with native TypeScript execution, built-in SQLite, solid `fetch`/SSE support, and a fast test runner. Alternatives: Node.js (with tsx/tsc), Deno, Bun.

## Decision

Bun (≥ 1.3.0) is the only supported runtime.

## Rationale

- **Native TS**: no build step for dev or production; `bun run src/index.ts` works directly.
- **`bun:sqlite`**: built in, FTS5 available, `loadExtension()` for `sqlite-vec`. No native bindings to compile.
- **`bun:test`**: fast test runner with a Jest-compatible API; no extra dep.
- **`Bun.serve`**: trivial to spin up a mock LLM server for tests that streams SSE chunks.
- **`Bun.TOML`**: built-in TOML parser for `bunny.config.toml` — matches the user preference for TOML over YAML.
- **Binary distribution**: `bun build --compile` later (one binary for Mac/Linux/Windows) fits the portability goal.
- **Ecosystem**: `bunqueue` is Bun-native; Node-compat would add unnecessary friction.

## Consequences

- Contributors must install Bun. Document in README.
- Node-only libraries that assume `fs.promises` APIs generally work, but C-native Node addons do not — avoid them.
- CI runs on Bun's official GitHub Action.

## Alternatives rejected

- **Node.js + tsx**: extra build/tooling layer, slower test runner, no built-in SQLite.
- **Deno**: excellent runtime but weaker ecosystem; `bunqueue` is Bun-specific.
