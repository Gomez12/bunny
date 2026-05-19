# ADR 0004 — bunqueue as audit spine

**Status:** Accepted
**Date:** 2026-04-14

## Context

Every meaningful event in the agent (LLM request, tool call, memory index) must be persisted for:
1. **Observability**: what did the agent do?
2. **Reproducibility**: reconstruct a session.
3. **Debugging**: why did the agent decide this?
4. **Future web UI**: show events/messages on a timeline.

Options: direct synchronous SQLite writes, an event bus (EventEmitter), or a persistent job queue.

## Decision

**bunqueue** as an embedded job queue. Every LLM call, tool call and memory-index action is pushed as a job onto the queue. The processor writes the event into the `events` table. The agent loop does not wait on the queue — logging is fire-and-forget.

## Rationale

- **bunqueue is Bun-native**: no Redis, no external server, embedded mode (`embedded: true`).
- **Audit semantics**: the queue provides durability (jobs survive crashes if the agent halts mid-processing) and at-least-once delivery.
- **Separation of concerns**: the agent loop does the real work (LLM call, tool call), and leaves logging to the queue. The loop is not blocked by logger I/O.
- **Extensible**: the same queue can later be used for real async job dispatch (e.g. an LLM call in a separate worker) by replacing the processor.
- **Topics as job names**: `llm.request`, `llm.response`, `tool.call`, `tool.result`, `memory.index` — queryable in the `events` table via `topic` and `kind` columns.

## Consequences

- Logging is async: right after `q.log(...)` the event is not yet in the DB. In tests `await q.close()` is needed to wait until the queue is drained.
- Bunqueue manages its own in-memory state (LRU maps for job tracking). On abnormal process exit in-flight logs may be lost. Acceptable for a logging use case.
- Each `createBunnyQueue(db)` call creates a new Bunqueue instance with a unique name (counter). This prevents state conflicts in tests.

## Alternatives rejected

- **Direct synchronous SQLite writes**: simple but blocks the event loop (no WAL advantage in the hot path).
- **Node EventEmitter**: no persistence; events disappear if the process crashes.
- **BullMQ**: requires Redis; breaks the "zero external services" requirement.
