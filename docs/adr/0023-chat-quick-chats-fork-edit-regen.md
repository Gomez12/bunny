# ADR 0023 — Chat refinements: Quick Chats, Fork, Edit & Regenerate

**Status:** Accepted
**Date:** 2026-04-18

## Context

The Chat tab persisted every conversation forever. There was no lightweight "throwaway question" mode, no way to copy a session's full context into a side-thread, no way to fix a typo in a message you just sent, and no way to ask the model for a different answer without manually retrying. Power users were either spamming the sidebar with experimental sessions or losing context every time they wanted to ask a tangential question.

This ADR captures the four affordances added to address that:

1. **Quick Chats** — sessions explicitly marked as throwaway. Visually distinguished in the sidebar; auto-hidden after ~15 minutes of inactivity by a scheduled task. Goal: keep the regular session list clean.
2. **Fork to Quick Chat** — copy an existing session's full message history into a brand-new Quick Chat so the user can ask a tangential question with full context, without polluting the parent thread.
3. **Edit message bubble** — three actions: **Save** (just rewrite the row), **Save and regenerate** (rewrite, soft-trim everything after, re-run the agent — *user messages only*), **Fork** (rewrite, then fork up-to-and-including).
4. **Regenerate answer** — button on assistant bubbles that produces an *alternate version* (kept as a sibling, navigable via `< 2/3 >`), not a destructive rewrite.

## Decision

### Schema (additive)

`messages`:
- `edited_at INTEGER` — set when content is rewritten.
- `trimmed_at INTEGER` — soft-delete pointer used by **save+regen**.
- `regen_of_message_id INTEGER` — chains an assistant message to the one it regenerated.

`session_visibility`:
- `is_quick_chat INTEGER NOT NULL DEFAULT 0` — per-user flag.
- `forked_from_session_id TEXT`, `forked_from_message_id INTEGER` — fork lineage.

The schema stays append-only: every new column is added via `ALTER TABLE` in `migrateColumns` (`src/memory/db.ts`), and the canonical `CREATE TABLE` statements in `src/memory/schema.sql` carry the same columns so a fresh install matches an upgraded one.

A new trigger `messages_fts_trim` removes a row from `messages_fts` the moment `trimmed_at` is set, so trimmed turns disappear from BM25 the same way deleted rows do.

### Soft-delete vs hard-delete (trim)

`save+regen` calls `trimSessionAfter(db, sessionId, pivotMessageId)` which sets `trimmed_at = now` on every row in the session whose `id` is greater than the pivot. We chose **id** rather than **ts** as the ordering key because messages inserted in the same millisecond share a `Date.now()` timestamp; an `id`-based predicate is deterministic.

Every `messages` read path (`getMessagesBySession`, `getRecentTurns`, `searchBM25`, `searchVector`, `listSessions`) now filters `AND trimmed_at IS NULL`. The session-owners ACL helper deliberately *ignores* `trimmed_at` — a user who has soft-deleted their own contributions still owns the session for permission purposes.

Counting trimmed rows: SQLite's FTS5 triggers cascade row writes that inflate `sqlite3_changes()` (we saw `result.changes === 13` for 3 trimmed rows). `trimSessionAfter` therefore takes a `SELECT COUNT(*)` snapshot before the UPDATE and returns that value.

### Regenerate — alt versions, not branching

`POST /api/messages/:id/regenerate` accepts both assistant and user message ids:

- **Assistant target.** Find the prior user message via `findPriorUserMessage(db, sessionId, targetId)`, run with `skipUserInsert: true` and `regenOfMessageId: targetId`. The first assistant content row in the new run carries `regen_of_message_id = targetId`. Subsequent multi-step rows (content rows that come after a tool call within the same run) do NOT — only the first one participates in the chain. This means flipping back to an older version only swaps the *final* answer; intermediate content from the previous run is unaffected. Acceptable for v1; documented under "out of scope" below.
- **User target.** Run with `skipUserInsert: true` and the user message's content as the prompt; no `regenOfMessageId` (the answer below it has been trimmed by the calling save+regen flow). Used by the **Save and regenerate** affordance — see below.

`getMessagesBySession` walks `regen_of_message_id` pointers in a single in-memory pass and attaches a `regenChain: { id, ts, content }[]` (root first, latest last) to each member. The frontend uses the latest entry as the displayed content and lets the user flip via `< n/m >`.

**Conscious limitation: chain, not tree.** Subsequent user messages stay anchored by `id` regardless of which version the user is currently viewing. Switching back to `A1` does not hide messages that were sent after `A2`. ChatGPT-style true branching (where switching back collapses everything that grew off the other branch) is a larger feature with cross-cutting recall implications; v1 keeps it simple and documents the caveat. The schema (`regen_of_message_id` pointer) does not preclude evolving to a tree later.

### Quick Chats are per-user

The flag lives on `session_visibility(user_id, session_id)` rather than a session-level table. That matches the existing `hidden_from_chat` pattern and means two users sharing a session can mark it differently. In practice, sessions have a single owner today, so this rarely matters — but it's the simpler ACL story.

### Auto-hide via scheduler

A new system handler `session.hide_inactive_quick_chats` (`src/scheduler/handlers/session_quick_chat.ts`) runs every 5 minutes (`*/5 * * * *`), seeded by `src/server/index.ts` alongside `board.auto_run_scan` and the translation handlers. Default inactivity threshold: **15 minutes**, configurable via the task's `payload.inactivityMs`.

The handler hides sessions where:
- `is_quick_chat = 1` AND `hidden_from_chat = 0` (already-hidden rows are skipped to avoid bumping `updated_at`)
- AND no non-trimmed message exists with `ts > now - inactivityMs`.

After hiding, the user can recover the session via the sidebar's "Show hidden" toggle. Nothing is deleted.

### Fork

`forkSession(db, srcSessionId, opts)` copies every non-trimmed message into a new session id, renumbers `ts` to `now + index*1ms` to preserve order without colliding with the source, and stamps the forking user's id onto every copied row. The new session's `session_visibility` row records `forked_from_session_id` (and the optional `forked_from_message_id` pivot) so the UI can show "forked from …" in the Quick Chat banner.

Embeddings are NOT cloned in v1 — the new rows have no `embeddings` table entries. FTS picks them up automatically via the existing insert trigger. A future janitor could re-embed forks on a queue job; for v1 the pragmatic call is that recall in a Quick Chat usually keys off the most recent few turns anyway.

### HTTP surface

All five new routes live in `src/server/chat_routes.ts` and are mounted from `routes.ts` *before* the generic `/api/sessions/:id` switch (so the more specific paths match first):

| Method + path | Behaviour |
|---|---|
| `PATCH /api/sessions/:id/quick-chat` | Per-user toggle. Body: `{ isQuickChat }`. |
| `POST /api/sessions/:id/fork` | Creates a new session id. Body: `{ untilMessageId?, asQuickChat?, project? }`. |
| `PATCH /api/messages/:id` | Edit content. ACL: message owner OR admin. |
| `POST /api/messages/:id/trim-after` | Soft-delete everything after this message in its session. |
| `POST /api/messages/:id/regenerate` | SSE stream. Target may be `assistant` (alt-version chain) or `user` (re-answer in place — used after save+regen trims the assistant turn). |

Every successful mutation logs through the queue with consistent topic/kind:
`session.quick_chat_toggle`, `session.fork`, `session.auto_hide`, `message.edit`, `message.trim`, `message.regenerate`.

### Frontend

`web/src/components/SessionSidebar.tsx`:
- "+ Quick" button next to "+ New chat" (visible when the parent passes `onNewQuickChat`).
- "Show hidden" checkbox in the Sessions section header.
- QC accent + small "QC" pill on quick-chat rows.

`web/src/components/MessageBubble.tsx`:
- Hover-reveal action row: ✎ Edit, ↻ Regenerate (assistant only), ⑂ Fork.
- Inline edit mode replaces the body with a textarea + Save / Save and regenerate (user msg only) / Fork / Cancel buttons.
- Version navigator (`< n/m >`) when `regenChain.length > 1`.

`web/src/tabs/ChatTab.tsx`:
- Composer footer: `Quick Chat` checkbox bound to `PATCH /api/sessions/:id/quick-chat`.
- Banner across the message pane when the active session is a Quick Chat (also shows the `forked_from` source when present).
- `regenIndex` keyed by user-prompt message id holds the user's selected version per turn (React state only, not persisted).
- After regenerate completes, the tab refetches the session's messages — the new chain entry surfaces with the navigator.

### Save and regenerate (user message)

The frontend wires this as: `patchMessage(promptId)` → `trimMessagesAfter(promptId)` → `POST /api/messages/promptId/regenerate` (which routes to the *user-target* branch above) → `refreshHistory()`. Re-using `/regenerate` rather than calling `/api/chat` with the edited content is critical — `/api/chat` would insert a *fresh* user row, leaving the user prompt visible twice in the session.

### Auto-hide guards against empty sessions

The handler's selector requires `EXISTS (SELECT 1 FROM messages WHERE session_id = sv.session_id AND trimmed_at IS NULL)` in addition to the inactivity predicate. Without that guard, a freshly-created Quick Chat (sidecar row inserted by `+ Quick`, no messages yet) would be hidden on the very next 5-minute tick — a user clicking the button and walking away briefly would return to find their session gone.

### Scope decisions and out-of-scope

- **No SSE broadcast for edits/trims in v1.** Two reserved event types (`message_edited`, `messages_trimmed`) are listed in the plan but not emitted by the routes — the frontend refetches after each mutation, which is enough for a single user editing their own messages. A future per-session SSE channel can introduce cross-tab live updates.
- **Hard-delete of trimmed messages is not implemented.** A future janitor handler can prune `WHERE trimmed_at < now - 90 days`. Until then, soft-deleted rows accumulate in the DB; FTS and recall already ignore them.
- **No re-embedding on fork.** See Fork section.
- **Selected regen version is not persisted.** Reload always shows the latest version per chain.
- **Multi-step content regeneration is partial.** When an assistant turn produced multiple content rows (because the model interleaved them with tool calls in a single run), only the *first* of those rows participates in the regen chain. Flipping back to an older alt version swaps the final answer alone; intermediate content from the previous run continues to render. A future "regen entire turn" affordance can chain by run id rather than message id.
