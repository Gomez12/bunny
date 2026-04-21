# Chat

## What it is

Live conversations with the agent. Sessions group messages; each message carries a role + channel (content / reasoning / tool_call / tool_result). Admins can switch to a "Mine / All" scope. Non-admins see only their own sessions.

Includes **Quick Chats** (throwaway sessions auto-hidden after 15 min), **fork** (clone history into a new session), per-bubble **edit / save+regenerate / fork**, and **regenerate-as-alt-version** (chained via `regen_of_message_id`, navigated `< n/m >`).

## Data model

- `messages` — one row per semantic unit. Columns: `session_id`, `role`, `channel`, `content`, `tool_call_id`, `tool_name`, `provider_sig`, `ok`, `duration_ms`, `prompt_tokens`, `completion_tokens`, `user_id`, `project`, `author`, `attachments`, `edited_at`, `trimmed_at`, `regen_of_message_id`.
- `messages_fts` — FTS5 virtual table mirroring `channel = 'content'` rows via triggers.
- `session_visibility` — per-user toggle: `hidden_from_chat`, `is_quick_chat`, `forked_from_session_id`, `forked_from_message_id`.
- `embeddings` — vec0 table, dimension baked in at DB open.

Key invariants:

- **One row per semantic unit.** Separate rows for content vs reasoning vs tool calls.
- **`messages.project` is the scope key** (NULL reads back as `'general'`).
- **FTS tracks `content` only** — never include reasoning / tool rows.
- **Reasoning is not replayed** (except Anthropic-compat signature roundtrip).

## HTTP API

- `POST /api/chat` — streaming SSE endpoint. Body: `{ prompt, sessionId?, project?, agent? }`. Flips `askUserEnabled = true` and `mentionsEnabled = true`.
- `GET /api/sessions` — list (filtered to own sessions for non-admins).
- `GET /api/sessions?project=<name>` — filter by project.
- `GET /api/sessions/:id/messages` — paginated message history.
- `PATCH /api/messages/:id` — edit content (owner only). Sets `edited_at`.
- `POST /api/messages/:id/regenerate` — regenerate as alt-version. Chains via `regen_of_message_id`. Sets `askUserEnabled = true`.
- `POST /api/sessions/:sessionId/questions/:questionId/answer` — resolves a pending `ask_user`.
- `POST /api/sessions/:id/fork` — copy non-trimmed history to a new Quick Chat.
- `PATCH /api/sessions/:id/visibility` — toggle `hidden_from_chat`, set `is_quick_chat`.

## Code paths

- `src/agent/loop.ts:runAgent` — the orchestrator.
- `src/memory/messages.ts` — `insertMessage`, `getRecentTurns`, `listSessions`, `listSessionMessages`.
- `src/memory/session_visibility.ts` — Quick Chat + hide flags.
- `src/memory/recall.ts:hybridRecall` — top-k injection.
- `src/server/chat_routes.ts` — `/api/chat`, `/api/messages/*`, `/api/sessions/*`, answer endpoint.
- `src/agent/mention.ts:parseMention` — strips leading `@agent`.
- `src/notifications/mentions.ts:parseUserMentions` — whole-prompt `@user` scanner.
- `src/agent/ask_user_registry.ts` — blocking-question primitive.

## UI

- `web/src/tabs/ChatTab.tsx` — the tab shell.
- `web/src/components/SessionSidebar.tsx` — sidebar with sessions + search + "Mine / All" admin toggle.
- `web/src/components/MessageBubble.tsx` — one bubble. Edit / regen / fork / alt-nav affordances.
- `web/src/components/ReasoningBlock.tsx` — dim italic accordion.
- `web/src/components/ToolCallCard.tsx` — tool call + result pair.
- `web/src/components/UserQuestionCard.tsx` — `ask_user` interactive card.
- `web/src/components/Composer.tsx` — input + send.
- `web/src/hooks/useSSEChat.ts` — streams a turn, accumulates into `Turn`.

## Extension hooks

- **Translation:** no (messages aren't translated).
- **Trash:** no (soft-delete happens at message level via `trimmed_at`, not row removal).
- **Notifications:** `mentionsEnabled` scans for `@user` and fires notifications. Only `POST /api/chat` sets it.
- **Scheduler:** no.
- **Agent tools:** every tool the loop registers is usable from chat by default.

## Key flows

### Send a message

```
POST /api/chat { prompt, sessionId, project, agent? }
  → runAgent({ askUserEnabled: true, mentionsEnabled: true, telegramCfg })
    → build system prompt + splice last_n + hybridRecall
    → stream LLM → SSE frames
    → tool_calls? → execute parallel → repeat
    → assistant content row → done
  → mention scanner fires notifications + Telegram pings
```

### Fork to Quick Chat

`POST /api/sessions/:id/fork`. Copies **non-trimmed** rows, flips `is_quick_chat = 1` on the new session's visibility row, records `forked_from_*` for provenance.

### Edit + regenerate

1. `PATCH /api/messages/:id` — update content, set `edited_at`.
2. `POST /api/messages/:id/regenerate` — soft-delete subsequent rows (`trimmed_at = now`), regenerate assistant response. Chain via `regen_of_message_id` for alt-version navigation.

## Gotchas

- Soft-delete via `trimmed_at` *removes* the row from FTS (`messages_fts_trim` trigger). Regenerating doesn't un-delete.
- `session_visibility.hide_inactive_quick_chats` auto-hides 15 min after last activity — a race exists where a quick chat that's *actively streaming* might get hidden; the sidebar filter masks this.
- `parseMention` (for agents) and `parseUserMentions` (for users) are different functions — see `concepts/notifications-and-fanout.md`. Agent-mention is leading-only; user-mention is whole-prompt.
- The Chat tab absorbed the former "Messages" tab. `LEGACY_TAB_ALIAS` maps `messages → chat`. The admin scope toggle is the merged UI.

## Related

- [ADR 0023 — Chat refinements: Quick Chats, Fork, Edit, Regenerate](../../adr/0023-chat-quick-chats-fork-edit-regen.md)
- [ADR 0026 — `ask_user` tool](../../adr/0026-ask-user-question-tool.md)
- [`../concepts/agent-loop.md`](../concepts/agent-loop.md)
- [`../concepts/memory-and-recall.md`](../concepts/memory-and-recall.md)
- [`../ui/streaming-ui.md`](../ui/streaming-ui.md)
