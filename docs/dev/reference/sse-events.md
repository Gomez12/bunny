# SSE events

Canonical type union: `src/agent/sse_events.ts`. Imported by both `src/agent/render_sse.ts` (backend) and `web/src/api.ts` (frontend) — compile-time drift guard.

Wire format: `data: {json}\n\n` per frame.

## Stream producers

| Producer | Endpoint | Emits |
| --- | --- | --- |
| `createSseRenderer` | `POST /api/chat` | `content`, `reasoning`, `tool_call`, `tool_result`, `usage`, `stats`, `error`, `turn_end`, `done`, `ask_user_question` |
| `runCard` fanout | `GET /api/cards/:id/runs/:runId/stream` | Same chat events + `card_run_started`, `card_run_finished` |
| KB generate handlers | `POST /api/projects/:p/kb/definitions/:id/generate` | Chat events + `kb_definition_generated` |
| KB illustration handler | `POST /api/projects/:p/kb/definitions/:id/generate-illustration` | Chat events + `kb_definition_illustration_generated` |
| Translation route | `POST /api/projects/:p/translations/:kind/:id/:lang` | Chat events + `translation_generated` |
| Notification stream | `GET /api/notifications/stream` | `notification_created`, `notification_read` |

## Every event

| Type | Payload (partial) | Notes |
| --- | --- | --- |
| `content` | `{ text, author? }` | Assistant content delta. `author` set for agents other than default. |
| `reasoning` | `{ text, author? }` | Thinking delta. Displayed as dim italic. |
| `tool_call` | `{ name?, id?, argsDelta, callIndex, author? }` | Per-call args accumulated across frames by `callIndex`. |
| `tool_result` | `{ name, ok, output, error?, author? }` | Matched to its `tool_call` by `name` / `id`. |
| `usage` | `{ promptTokens, completionTokens, totalTokens }` | Emitted once per LLM call. |
| `stats` | `{ durationMs, promptTokens?, completionTokens? }` | Emitted once per turn. |
| `error` | `{ message }` | Stream error; the consumer should mark the turn failed. |
| `turn_end` | `{ author? }` | End of one assistant message. Multiple per turn if tool iterations. |
| `done` | `{}` | Stream closing. |
| `card_run_started` | `{ cardId, runId, sessionId }` | First frame on `/api/cards/:id/runs/:runId/stream`. |
| `card_run_finished` | `{ cardId, runId, status, finalAnswer?, error? }` | Last frame. Mirrors `board_card_runs` state. |
| `kb_definition_generated` | `{ definitionId, sources }` | Text generation done. |
| `kb_definition_illustration_generated` | `{ definitionId, bytes }` | SVG generation done. |
| `translation_generated` | `{ kind, entityId, lang, status, error? }` | Emitted only for in-session runs (interactive translate-now). Background scheduler runs don't broadcast. |
| `web_news_run_finished` | `{ topicId, project, status, inserted?, duplicates?, error? }` | **Reserved** — v1 frontend polls. |
| `web_news_topic_status` | `{ topicId, project, status }` | **Reserved** — v1 frontend polls. |
| `ask_user_question` | `{ questionId, question, options, allowCustom, multiSelect, author? }` | Blocking; reply via `POST /api/sessions/:sid/questions/:qid/answer`. |
| `notification_created` | `{ notification: NotificationDto }` | In recipient's per-user fanout. |
| `notification_read` | `{ ids: number[], readAt }` | Empty `ids` = mark-all-read. Echoed to own fanout so other tabs sync. |

## Replay behaviour

- **Chat stream** — no replay. Reconnect = start a new turn or read history from `/api/sessions/:id/messages`.
- **Card run stream** (`runCard` fanout) — replay buffer, 60s grace window post-close. Late subscriber rebuilds the whole run.
- **Notification stream** — no replay. Reconnect = call `GET /api/notifications` for history.
- **KB / translation streams** — short-lived, no replay (their final-state events are idempotent enough to miss).

## Adding a new event type

1. Add the interface + union member in `src/agent/sse_events.ts`. This is the compile-time anchor.
2. Implement the producer (backend). Emit the frame via the renderer or a direct controller write.
3. Handle the type in the consumer (`web/src/hooks/useSSEChat.ts`, `useNotifications.ts`, a card run hook, etc.). Unknown types are ignored — but known types should have explicit handling.
4. Document in this page + the entity page.

See [`../how-to/add-an-http-route.md`](../how-to/add-an-http-route.md) for the switch wiring and [`../concepts/streaming-and-renderers.md`](../concepts/streaming-and-renderers.md) for the producer side.

## Related

- [`../concepts/streaming-and-renderers.md`](../concepts/streaming-and-renderers.md)
- [`../ui/streaming-ui.md`](../ui/streaming-ui.md)
- `src/agent/sse_events.ts` — canonical.
