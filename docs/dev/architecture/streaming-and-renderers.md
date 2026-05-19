# Streaming and renderers

## At a glance

Four layers sit between the LLM provider and a user's terminal or browser:

```
Provider HTTP(S)  →  stream.ts (SSE / chunked bytes)
                  →  profiles.ts (normaliser per provider)
                  →  adapter.ts (uniform deltas + final response)
                  →  Renderer (transport-specific sink)
```

The `Renderer` interface makes the agent loop transport-agnostic. The same `runAgent` call drives the CLI (ANSI), the web UI (SSE), a scheduled task (silent), and a subagent call (collecting).

## Where it lives

- `src/llm/adapter.ts:chat` — returns `{ deltas: AsyncIterable<StreamDelta>, response: Promise<LlmResponse> }`.
- `src/llm/stream.ts` — multi-byte-safe SSE parser.
- `src/llm/profiles.ts` — per-provider normalisers. **Only** place that contains provider branches.
- `src/agent/render.ts` — `Renderer` interface + `createRenderer` (ANSI CLI).
- `src/agent/render_sse.ts:createSseRenderer` — JSON over SSE for the web UI.
- `src/agent/sse_events.ts` — shared type union imported by backend *and* frontend.

## The `Renderer` interface

```ts
interface Renderer {
  onDelta(delta: StreamDelta): void;
  onToolResult(result: ToolResult): void;
  onError(err: unknown): void;
  onTurnEnd(): void;
  onAskUserQuestion?(ev: SseAskUserQuestionEvent): void;
  onQueueWait?(ev: { position: number }): void;
  onQueueRelease?(ev: { waitedMs: number }): void;
}
```

The three optional callbacks let renderers opt into surfaces that the agent loop only needs when the transport supports them — interactive questions for the chat UI, queue-state badges for any UI that wants to differentiate "waiting on the model" from "waiting in the upstream queue" (see [ADR 0035](../../adr/0035-llm-concurrency-gate.md)).

Four implementations ship in-tree:

| Renderer | Where | Purpose |
| --- | --- | --- |
| `createRenderer` | `render.ts` | ANSI for the CLI. Dim-italic for reasoning, cyan for tool calls. |
| `createSseRenderer` | `render_sse.ts` | Emits `SseEvent` frames over a `ReadableStreamDefaultController`. |
| silent | inline (see `src/board/run_card.ts`, `src/web_news/run_topic.ts`) | No-op; used for background runs where the caller only needs the final row. |
| collecting | inline (see `src/telegram/handle_update.ts`) | Buffers content deltas to produce a single reply string. |

Add a new transport by implementing this interface. Never branch inside `loop.ts`.

## Provider profiles

`src/llm/profiles.ts` is the *only* place that contains per-provider branches. Every other module stays provider-agnostic.

| Profile | content | reasoning |
| --- | --- | --- |
| `openai` | `choices[].delta.content` | `choices[].delta.reasoning_content`\* |
| `deepseek` | `choices[].delta.content` | `choices[].delta.reasoning_content` |
| `openrouter` | pass-through | pass-through |
| `ollama` | `choices[].delta.content` | — |
| `anthropic-compat` | content-block | `thinking` block + signature |

\* Only `o1` / `o3` and specific OpenAI variants produce reasoning.

Reasoning is stored on `messages.channel = 'reasoning'` and **not** sent back on the next turn — except for Anthropic-compat, which requires the thinking-block signature (`provider_sig` column) to round-trip.

## SSE event contract

`src/agent/sse_events.ts` exports the full `SseEvent` union. Because the file is imported by both `render_sse.ts` and `web/src/api.ts`, adding a new event type is a compile error on both sides — no silent drift. Vite's `server.fs.allow: [".."]` permits the cross-root import.

Current types: `content`, `reasoning`, `tool_call`, `tool_result`, `usage`, `stats`, `error`, `turn_end`, `done`, `card_run_started`, `card_run_finished`, `kb_definition_generated`, `kb_definition_illustration_generated`, `translation_generated`, `web_news_run_finished`, `web_news_topic_status`, `ask_user_question`, `llm_queue_wait`, `llm_queue_release`, `notification_created`, `notification_read`, plus the workflow + code-graph quartets.

See [`../reference/sse-events.md`](../reference/sse-events.md) for the full table (producer, consumer, replay behaviour).

## Upstream concurrency gate

`chat()` is wrapped by a process-wide semaphore (`src/llm/concurrency_gate.ts`) configured by `cfg.llm.maxConcurrentRequests` (TOML `[llm] max_concurrent_requests`, env `LLM_MAX_CONCURRENT_REQUESTS`, **default 1**). When all permits are taken, callers wait FIFO; the renderer's `onQueueWait?` fires *before* the await with the 1-based queue position, and `onQueueRelease?` fires after acquire just before `fetch()` runs. The pair is paired — calls that slip in below the cap don't surface either event, so the chat UI never shows a queue badge for unqueued turns.

Front-end pause behaviour: the `useSSEChat` hook treats `queueState === "waiting"` exactly like an unanswered `ask_user_question` — the live elapsed-time counter freezes via the same `pausedAtMs` / `pausedTotalMs` bookkeeping. Result: queue time is excluded from the displayed wall-clock duration, so a 30-second wait followed by a 5-second generation reads as "5s" on the bubble. See [ADR 0035](../../adr/0035-llm-concurrency-gate.md).

## Key invariants

- **All provider quirks in `profiles.ts`.** Every other module sees a uniform stream.
- **SSE over `fetch` body-reader, not `EventSource`.** The frontend POSTs JSON, which `EventSource` cannot do. See `../ui/streaming-ui.md`.
- **Bun.serve sets `idleTimeout: 0`.** Long-lived SSE streams survive past the default timeout.
- **Reasoning is display-only** (except Anthropic-compat). Sending it back confuses other providers.
- **Gate release happens in `fanOut`'s `finally`.** All success and error paths funnel through one `release()`. Callers that abandon `deltas` without iterating risk leaking the gate — by contract every caller drains.

## Gotchas

- SSE frames are `data: {json}\n\n`. The parser in `stream.ts` is multi-byte-safe — don't reimplement it elsewhere.
- When buffering, always split on the double-newline, not on `\n` alone.
- OpenRouter pass-through means the *same* model can present as `openai` or `anthropic-compat` depending on which upstream it resolves to; configure the profile explicitly.
- The CLI renderer assumes a TTY. Piping output to a file silently strips ANSI — for scripted use, use `createSseRenderer` or write a new silent renderer.

## Related

- [ADR 0002 — OpenAI-compat adapter](../../adr/0002-openai-compat-adapter.md)
- [ADR 0005 — Streaming and reasoning normalisation](../../adr/0005-streaming-reasoning.md)
- [ADR 0035 — LLM concurrency gate](../../adr/0035-llm-concurrency-gate.md)
- [`agent-loop.md`](./agent-loop.md) — how the loop consumes the stream.
- [`../ui/streaming-ui.md`](../ui/streaming-ui.md) — what the frontend does with SSE frames.
- [`../how-to/add-a-provider.md`](../how-to/add-a-provider.md) — add a new provider profile.
