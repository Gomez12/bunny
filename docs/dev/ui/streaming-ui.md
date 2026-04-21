# Streaming UI

## At a glance

The web UI consumes the same SSE event types the backend emits from `src/agent/render_sse.ts`. One hook (`useSSEChat`) owns the fetch + body-reader + event accumulation; every frame maps to a field on a `Turn` record, which the bubble re-renders.

SSE lands via **`fetch` body-reader**, not `EventSource`, because the chat endpoint POSTs JSON. `EventSource` cannot do POSTs.

## Where it lives

- `web/src/hooks/useSSEChat.ts` — the fetch + reader + `Turn` accumulator.
- `web/src/api.ts` — `SseEvent` type import + `parseSseFrame` helper.
- `web/src/components/MessageBubble.tsx` — renders one message row.
- `web/src/components/ReasoningBlock.tsx`, `ToolCallCard.tsx`, `UserQuestionCard.tsx` — compose inside the bubble.
- `src/agent/sse_events.ts` — the shared type union (also used by the backend).

## The request

```ts
const res = await fetch("/api/chat", {
  method: "POST",
  credentials: "include",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ prompt, sessionId, project, agent }),
  signal: abort.signal,
});
const reader = res.body!.getReader();
```

The response is a raw SSE stream (`text/event-stream`). The parser splits on `\n\n`, pulls the `data: …` prefix, JSON-parses the payload, and dispatches by `type`.

## The `Turn` state machine

Each user turn produces a `Turn` record the bubble renders. Fields:

```ts
type Turn = {
  userPrompt: string;
  content: string;                    // assistant content — appended from `content` frames
  reasoning: string;                  // dim italic — appended from `reasoning` frames
  toolCalls: ToolCall[];              // one per tool_call + matching tool_result
  userQuestions: AskUserQuestion[];   // stack of active ask_user cards
  usage?: { prompt: number; completion: number };
  stats?: { durationMs: number };
  status: "streaming" | "done" | "error";
  error?: string;
};
```

Event → field mapping:

| SSE `type` | Effect |
| --- | --- |
| `content` | Append `text` to `content`. |
| `reasoning` | Append `text` to `reasoning`. |
| `tool_call` | Update or append to `toolCalls[callIndex]`. `argsDelta` accumulates. |
| `tool_result` | Match by `name` / `id` to an existing entry; set `ok`, `output`, `error`. |
| `ask_user_question` | Push onto `userQuestions`. Card is interactive until the user answers. |
| `usage` | Set `usage`. |
| `stats` | Set `stats`. |
| `error` | Set `status = "error"`, `error = message`. |
| `turn_end` | Finalise the current assistant row; mark the turn ready for the next. |
| `done` | Set `status = "done"`. Close the stream. |

## Interactive cards

Some frames need user interaction mid-stream:

### `ask_user_question`

`UserQuestionCard` renders a radio/checkbox panel + optional free-form textarea. On submit:

```ts
await fetch(`/api/sessions/${sessionId}/questions/${questionId}/answer`, {
  method: "POST",
  credentials: "include",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ answer }),
});
```

The server-side registry in `src/agent/ask_user_registry.ts` resolves the pending promise; the `runAgent` loop picks the answer up as the tool result and continues. 404 = stale question (timed out or session ended).

### `card_run_*` (board)

The Board's `CardRunLog` subscribes to `/api/cards/:id/runs/:runId/stream` — a separate fanout from the chat stream. `card_run_started` / `card_run_finished` shape the run log panel.

## Per-bubble affordances

`MessageBubble` shows, based on user role and message state:

- **Edit** — opens inline textarea, `PATCH /api/messages/:id` on save.
- **Save + Regenerate** — soft-deletes subsequent rows (sets `trimmed_at`), posts a new chat.
- **Fork to Quick Chat** — copies non-trimmed history into a new session with `is_quick_chat = 1`.
- **Regenerate-as-alt-version** — `POST /api/messages/:id/regenerate`. Chains via `regen_of_message_id`. Navigate alts with `< n/m >` on the bubble.

See [`../entities/chat.md`](../entities/chat.md) for the full matrix.

## Rules

- **SSE via `fetch` body-reader**, never `EventSource`. The endpoints POST JSON.
- **`credentials: "include"`** on every stream request — the cookie is the auth.
- **Parse frames with a `\n\n` split**, not a `\n` split. SSE frames are double-newline-terminated.
- **Unknown `type` values are ignored**, not fatal. Forward-compat for backend rollouts.
- **Abort on unmount.** `AbortController` on the fetch; the reader loop exits on abort.
- **One `Turn` per user prompt.** Don't merge turns; the bubble renders per row.

## Gotchas

- Bun.serve sets `idleTimeout: 0` on the server — SSE streams can live arbitrarily long. The client must still handle disconnects (`onerror`, visibility change).
- `turn_end` vs `done`: `turn_end` marks the end of *one* assistant message — on a multi-tool-iteration turn there's one per iteration. `done` is the stream closing.
- Reasoning text is *stored* (for the Logs tab + re-opening a session) but *not replayed* to the LLM. If you hide it from the bubble, keep it in the DB.
- The Anthropic-compat roundtrip needs `provider_sig`. Don't drop it during replay.

## Related

- [`../concepts/streaming-and-renderers.md`](../concepts/streaming-and-renderers.md) — the backend side.
- [`../reference/sse-events.md`](../reference/sse-events.md) — every event, producer, consumer.
- [`./component-library.md`](./component-library.md) — `MessageBubble`, `ToolCallCard`, `ReasoningBlock`, `UserQuestionCard`.
- [`../entities/chat.md`](../entities/chat.md).
