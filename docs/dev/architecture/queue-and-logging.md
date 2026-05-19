# Queue and logging

## At a glance

The queue (`bunqueue`) is the spine. Every meaningful action runs as a fire-and-forget job that writes one row to the append-only `events` table. That includes LLM requests, tool calls, memory writes, **and every HTTP mutation**. Nothing is invisible; nothing blocks the caller.

The guiding rule: *if a write happened, `events` knows about it*. The Dashboard, Logs tab, and admin audit trail all read from this one table.

## Where it lives

- `src/queue/bunqueue.ts` — wrapper around the [bunqueue](https://github.com/egeominotti/bunqueue) library.
- `src/queue/types.ts` — `LogPayload` with optional `userId`.
- `src/memory/schema.sql` — `events` table + `idx_events_session` + `idx_events_topic`.
- `src/memory/stats.ts` — Dashboard queries that roll up `events`.

## The `events` row

```sql
CREATE TABLE events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,          -- Unix ms
  topic       TEXT    NOT NULL,          -- domain noun
  kind        TEXT    NOT NULL,          -- verb or dotted verb
  session_id  TEXT,
  payload_json TEXT,                     -- full job payload (input + output)
  duration_ms INTEGER,
  error       TEXT,                      -- null on success
  user_id     TEXT                       -- owning user (null = anonymous/historical)
);
```

- Append-only. Never `DELETE`.
- `topic` is the domain noun. `kind` is the verb. Together they name an action.
- `session_id` is optional — set for chat turns + background runs that own a hidden session.
- `user_id` is stamped from the request context; rows without it came from pre-auth seeding or the `system` user.
- `payload_json` carries full input + output for debuggability. **Never** include secrets (passwords, API-key values, tokens, webhook secrets).

## The mutation-logging mandate

Every successful HTTP mutation logs exactly one row:

```ts
void ctx.queue.log({
  topic: "project",
  kind: "create",
  userId: ctx.user.id,
  data: { projectName },
});
```

Rules:

- **`void` the call.** Fire-and-forget. Awaiting it would serialise the response behind disk I/O.
- **Log after the write succeeds**, not before — a log without a corresponding write is misleading.
- **Every route context carries `queue: BunnyQueue`.** `AuthRouteCtx`, `WorkspaceRouteCtx`, `AgentRouteCtx`, `ScheduledTaskRouteCtx`, `BoardRouteCtx` — they all include it. The switch wiring is the boundary: once you're inside a handler, `ctx.queue` is always there.
- **Read routes don't log.** Only mutations.

## Topic / kind conventions

Topics are short nouns. Kinds are verbs or dotted verbs. Both are lowercase snake_case.

| Topic | Example kinds |
| --- | --- |
| `project` | `create`, `update`, `delete` |
| `board` | `swimlane.create`, `card.move`, `card.archive`, `card.run` |
| `agent` | `create`, `update`, `link`, `unlink` |
| `task` | `create`, `update`, `enable`, `disable`, `run_now` |
| `workspace` | `write`, `mkdir`, `move`, `delete` |
| `auth` | `login.ok`, `login.failed`, `logout`, `password.change` |
| `apikey` | `create`, `revoke` |
| `user` | `create`, `update`, `delete` |
| `session` | `hide`, `unhide`, `fork`, `quick_chat.create` |
| `document` / `whiteboard` / `contact` / `kb` | `create`, `update`, `delete`, `soft.delete` (bin), `restore`, `hard.delete` |
| `web_news` | `topic.create`, `topic.run`, `topic.renew_terms`, `item.delete` |
| `trash` | `restore`, `hard_delete` |
| `telegram` | `config.update`, `webhook.register`, `message.inbound`, `message.outbound`, `link.create.pending`, `link.create.confirm`, `poll.tick`, `rate_limit`, `error` |
| `notification` | `create`, `read`, `read.all`, `delete` |

New topics don't require ceremony — pick a short domain noun and document it here + in `docs/http-api.md`.

## Key invariants

- **Append-only.** Never `DELETE FROM events`. If you need to prune, write a scheduled task that copies old rows elsewhere first.
- **`void ctx.queue.log(...)`.** Always fire-and-forget.
- **Never log secrets.** If a token is in scope, log only `tokenTail` (last 4 chars).
- **Stamp `userId`.** When an authenticated user is available, log their id. `null` is reserved for pre-auth or seed operations.

## Gotchas

- `duration_ms` is for the *job*, not the HTTP request. LLM calls, tool calls, embed calls all set it; plain CRUD leaves it null.
- `error` is the failure mode signal. Dashboard "error rate" and the Logs tab filter on it — so the difference between "no error" and "empty string" matters. Use `null` for success.
- If a background runner produces a hidden session (board card run, web news topic, translation, KB generate), the log row gets its `session_id` — useful for correlating "open in chat" deep links.
- The queue is intentionally in-process, not Redis-backed. `$BUNNY_HOME` is the state boundary; adding an external broker would break portability.

## Related

- [ADR 0004 — Bunqueue as spine](../../adr/0004-bunqueue-as-spine.md)
- [`../entities/dashboard.md`](../entities/dashboard.md) — reads `events` via `src/memory/stats.ts`.
- Logs tab — admin-only surface for browsing events, in `web/src/tabs/LogsTab.tsx`.
