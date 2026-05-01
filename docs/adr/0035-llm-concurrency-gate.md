# ADR 0035 — LLM concurrency gate with default-1 cap

Status: Accepted — 2026-04-30

## Context

`bunqueue` (`src/queue/bunqueue.ts`) is a logging spine — it serialises writes
to the `events` table, nothing more. The actual upstream chat-completion call
happens in `src/llm/adapter.ts:chat()` via a bare `fetch()` with no timeout,
no `AbortController`, and no throttle.

A growing collection of code paths can therefore call `chat()` in parallel:

- multiple `runAgent` instances side by side: chat + regenerate, two browser
  tabs, an inbound Telegram DM, a board card-run, a web-news topic-run, a
  workflow run, code edit/chat, document/whiteboard/contact edit-mode, KB
  generate, code-graph doc-extract;
- scheduled handlers (`memory.refresh`, `kb.auto_generate_scan`,
  `board.auto_run_scan`, `translation.auto_translate_scan`,
  `web_news.auto_run_scan`) that all call `runAgent` from their own ticks;
- `web_news`'s explicit `MAX_CONCURRENT = 3` topic fan-out, which becomes 3
  upstream calls when topics fire concurrently.

Users running against a single-GPU `llama.cpp` upstream observed two requests
in flight simultaneously despite the assumption that bunqueue serialised
everything. They want a config knob to cap upstream concurrency, with a
default of 1 (the safest baseline for a single-GPU host), and they want the
chat UI to show when a turn is queued so the elapsed-time counter doesn't
falsely indicate slow generation while the request is just waiting.

## Decision

Introduce a process-wide semaphore around `chat()` and surface its state to
renderers via two optional callbacks.

### 1 — Config knob

`LlmConfig.maxConcurrentRequests: number` (default 1) in `src/config.ts`,
read from `[llm] max_concurrent_requests` in `bunny.config.toml` or
`LLM_MAX_CONCURRENT_REQUESTS` env var. Validation: positive integer ≥1;
malformed values fall back to 1 with a stderr warn.

### 2 — Process-wide gate

`src/llm/concurrency_gate.ts` exports `createConcurrencyGate(cap)` plus a
module-level singleton `getGlobalGate(cap)`. The singleton is cap-mutable
(`setCap(n)`) so a future hot-reload of `bunny.config.toml` can adjust the
limit without restart; lowering the cap below the current `inFlight` does
**not** abort running calls — only future acquires fall under the new cap.

`acquire()` is FIFO. When `inFlight >= cap`, the caller is pushed onto a
waiter queue and resolves in arrival order. `release()` decrements `inFlight`
and shifts one waiter. Tests get `__resetGlobalGateForTests` and
`__setGlobalGateForTests` for isolation.

### 3 — Adapter integration

`chat()` accepts an optional `ChatOpts = { gate, onQueueWait, onQueueRelease }`.
The gate is acquired **before** `fetch()` so a queued request never holds an
HTTP socket. Release happens in the `fanOut()` generator's `finally` block so
both the success path (stream fully drained) and the error paths (fetch
rejection, non-2xx response, missing body, stream error) funnel through
exactly one `release()`. `onQueueWait` and `onQueueRelease` are paired —
they fire only when the request actually had to wait, so unqueued calls
don't surface a no-op queue badge to the UI.

### 4 — Renderer + SSE events

The `Renderer` interface gains two optional methods, mirroring the existing
optional-method pattern of `onAskUserQuestion?`:

- `onQueueWait?({ position })` — 1-based position when the request joined.
- `onQueueRelease?({ waitedMs })` — wall-clock wait time when released.

`render_sse.ts` emits two new SSE events (added to the discriminated
`SseEvent` union):

- `llm_queue_wait { type, position, since }`
- `llm_queue_release { type, waitedMs }`

Frontend `useSSEChat` extends `Turn` with `queueState: "waiting" | "active" |
null`, `queuePosition: number`, and `queueWaitTotalMs: number` (accumulator
across multi-iteration turns). The 150 ms tick that drives the live elapsed
timer treats `queueState === "waiting"` as a **pause condition**, identical
to the existing `awaiting` (any unanswered `ask_user` question) — both use
the same `pausedAtMs` / `pausedTotalMs` machinery. Result: the elapsed timer
freezes during queue waits and resumes from where it stopped, never
counting queue time as model-generation time.

### 5 — Default 1, raisable

The default `max_concurrent_requests = 1` matches the typical single-GPU
self-hosted upstream. Multi-user installations and providers that support
parallel decoding (OpenAI, Anthropic, deployments with `n_parallel > 1` on
llama.cpp) can raise it.

## Consequences

- Long chat streams now block scheduled handlers (`memory.refresh`,
  `kb.auto_generate`, `board.auto_run`, etc.). For a 2-minute chat, an
  `memory.refresh` tick that happens to coincide gets queued behind it.
  This is acceptable because the alternative — having the user's chat slow
  down because it's contending with a 30-row backfill — is worse. Operators
  who want background work to proceed in parallel should raise the cap.
- `web_news.MAX_CONCURRENT = 3` keeps its topic-level concurrency, but each
  topic's `runAgent` call still goes through the gate, so the effective
  upstream load is bounded by the gate cap regardless.
- Subagents via `call_agent` are safe: the parent `runAgent`'s `chat()` has
  already released the gate by the time tools execute, so a subagent
  acquires fresh.
- The gate is process-wide and in-memory. Two Bunny processes against the
  same upstream do **not** coordinate. Multi-process installs need an
  external rate limiter — out of scope for v1.
- Embeddings are NOT routed through the gate. Hybrid-recall does
  `Promise.all([searchBM25, embed])`; gating the embedding call would
  serialise recall behind any in-flight chat, slowing the user-facing path
  with no benefit (embeddings are cheap, often hit a separate endpoint).

## Alternatives considered

- **Per-source quotas** (KB-3 / web-news-3 / chat-1). Adds complexity; v1
  needs a single global throttle. Per-source quotas can layer on top later
  if one source structurally starves another.
- **Token-bucket rate limit** (requests-per-second). A different knob —
  complementary, not a substitute. Useful when the upstream itself imposes
  a rate limit. Can layer on top.
- **Auto-detect llama.cpp `n_parallel`**. Requires endpoint introspection
  and is provider-specific. Operator can set the value explicitly today;
  auto-detection is an optimisation, not a feature.
- **Abort lopende calls on `setCap(n)` met n < inFlight**. Aborting a
  streaming call mid-flight produces partial responses and dangling SQL
  rows. Letting them finish under the old cap is simpler and safer.
