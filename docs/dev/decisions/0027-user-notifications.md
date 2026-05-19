# ADR 0027 — User notifications

Status: Accepted — 2026-04-19

## Context

Until now Bunny had no way for a human collaborator to learn that something
needs their attention. Chat is collaborative, boards carry assignments,
scheduled tasks complete in the background — yet none of this was surfaced to
the user unless they happened to be looking at the right tab. The first
trigger we care about is chat mentions: typing `@alice` in any prompt should
ping Alice. Future triggers (board-card assignment, task run finished, web
news update) follow the same shape, so the subsystem is deliberately generic
even though v1 only wires up the mention path.

## Decision

Introduce a per-user (cross-project) `notifications` subsystem: a single
table, a small HTTP surface, an in-memory per-user SSE fanout, a mention
scanner that runs as a fire-and-forget hook on user chat turns, and a web UI
bell + panel + in-app toast + OS-level toast (web `Notification` API in the
browser, `tauri-plugin-notification` in the Tauri desktop client).

### Schema (append-only)

One new table in `src/memory/schema.sql`:

```sql
CREATE TABLE notifications (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id             TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind                TEXT    NOT NULL,     -- 'mention' | 'mention_blocked' | …
  title               TEXT    NOT NULL,
  body                TEXT    NOT NULL DEFAULT '',
  actor_user_id       TEXT    REFERENCES users(id) ON DELETE SET NULL,
  actor_username      TEXT,                  -- denormalised for the panel
  actor_display_name  TEXT,
  project             TEXT,
  session_id          TEXT,
  message_id          INTEGER,
  deep_link           TEXT    NOT NULL DEFAULT '',
  read_at             INTEGER,
  created_at          INTEGER NOT NULL
);
```

`actor_username` / `actor_display_name` are denormalised copies so the panel
still reads correctly after the actor is deleted. `read_at IS NULL` means
unread. `deep_link` is a frontend-relative query string (`?tab=chat&project=…
&session=…#m<id>`). The dispatcher prunes each user's list back to the
newest 200 rows on every insert so the table and the panel stay bounded.

### Mention detection

The existing `src/agent/mention.ts` parser only looks for a leading `@agent`
token. User mentions must be allowed anywhere in the prompt (including
multiple mentions per turn), so we add a new scanner at
`src/notifications/mentions.ts:parseUserMentions`:

- `@` must be at start-of-string or preceded by a char **not** in
  `[A-Za-z0-9_:/.@-]`. This excludes emails (`foo@bar.com`), URLs
  (`https://x.com/@alice`), header-style `cc:@user`, and path-like
  `folder/@user`.
- Username body reuses `AGENT_NAME_RE` (`[a-z0-9][a-z0-9_-]{0,62}`),
  case-insensitive.
- Trailing boundary: end-of-string or a char **not** in `[A-Za-z0-9_-]`.
- Fenced ```` ``` ```` blocks and inline `` ` `` spans are stripped before
  scanning, so a mention pasted inside a code sample does not fire.
- Return value is deduped lower-case, first-appearance order.

### Leading `@username` collision with `@agent`

`handleChat` currently strips a leading `@name` via `parseMention` and 404s
when the name doesn't resolve to an agent. A user named `alice` typing
`@alice hi` would therefore 404 before the mention scanner could see the
prompt. Fix: only strip the leading `@name` when `getAgent(db, parsed.agent)`
actually returns a row. An unknown leading token is left intact and flows
through to the scanner, which will resolve it as a user mention.

### Dispatcher and permissions

`dispatchMentionNotifications` resolves each candidate via
`getUserByUsernameCI`, then:

- **Self-mention** → skipped.
- **Unknown username** → dropped silently.
- **Recipient can see the project** → one `mention` row, queue-logged with
  `topic: "notification"`, `kind: "create"`, and the per-user fanout
  `publish` callback is invoked so live SSE subscribers (other tabs) see it
  immediately.
- **Recipient cannot see the project** → no row for the recipient. After the
  loop, a **single aggregated `mention_blocked` row** is written to the
  sender listing every blocked username. This makes it unambiguous to the
  sender that `@alice` in a project Alice cannot see produced nothing, while
  telling Alice nothing about the event.

Errors from the insert path are caught and logged via the queue with
`kind: "create.error"`; they never bubble up into the agent loop.

### Gating via `mentionsEnabled`

Mirrors `askUserEnabled` from ADR 0026. A new
`RunAgentOptions.mentionsEnabled` flag controls whether the agent loop fires
the dispatcher after the user-turn `insertMessage()`. Only
`POST /api/chat` sets it to `true`. `POST /api/messages/:id/regenerate`,
document/whiteboard/KB/contact edit paths, board-card runs, scheduled tasks
and subagent invocations all leave it off, so re-runs and background work
never produce duplicate notifications.

### Per-user SSE fanout

Modelled on `src/board/run_card.ts` but with two differences:

1. **No replay buffer.** A long-lived subscriber wouldn't benefit from one,
   and the memory floor matters. Late subscribers call
   `GET /api/notifications` for history.
2. **Keepalive.** User streams are long-lived; corporate proxies and the
   Tauri webview drop idle connections silently. The fanout emits
   `: ping\n\n` every 25 s (a comment line, which the existing
   `openSseStream` frame parser already skips).

Map entry is dropped when the last subscriber for a user leaves. `logout`
calls `closeAllFor(user.id)` so stale subscribers can't sit on server memory
after a revoked session.

### Multi-tab read sync

`PATCH /api/notifications/:id/read` and `POST /api/notifications/mark-all-read`
publish an `SseNotificationReadEvent` into the user's own fanout, so Tab A
marking something read decrements Tab B's unread badge inside one SSE frame.

### HTTP

`src/server/notification_routes.ts` owns the surface:

- `GET /api/notifications?unread=1&limit=50&before=<id>` → `{ items, unreadCount }`
- `PATCH /api/notifications/:id/read`
- `POST /api/notifications/mark-all-read`
- `DELETE /api/notifications/:id`
- `GET /api/notifications/stream` (SSE)

Every route scopes by `user.id`; reading another user's notification returns
a 404 rather than a 403 so the existence of the row isn't revealed.

Mount point in `src/server/routes.ts`: after `handleTranslationRoute`,
before `handleScheduledTaskRoute`.

### Frontend

- `web/src/lib/icons.ts` re-exports `Bell` / `BellDot`.
- `useNotifications` hook owns `{ items, unreadCount, loaded }`, fetches an
  initial page on auth, opens the SSE stream, reconciles both new-event and
  read events.
- `NotificationBell` sits inside `.nav__user` at the bottom of the sidebar
  with a capped "9+" unread badge. First click requests browser permission
  for Web Notifications (must be a user gesture).
- `NotificationPanel` is a floating popover; row click marks-read and
  navigates to the deep-link. A "Load more" footer paginates backwards via
  the `before=<id>` cursor.
- `ToastStack` is a top-right fixed stack, auto-dismiss 5 s, hover-pause,
  CSS tokens per `docs/styleguide.md`. New `notification_created` events
  push a toast unless the panel is open.
- `osToast.show({ title, body, onClick })` feature-detects `window.__TAURI__`
  and routes to `@tauri-apps/plugin-notification` on desktop or
  `window.Notification` in the browser. Silent no-op when permission is
  denied.
- Deep-link: `App.tsx` parses `?tab=chat&project=…&session=…#m<id>` on boot
  to jump into the right tab and scroll target.

### Tauri

`tauri-plugin-notification = "2"` in `client/src-tauri/Cargo.toml`,
registered in `lib.rs`, with `notification:default` added to the
capabilities manifest. `@tauri-apps/plugin-notification` is added to
`client/package.json` for typed JS helpers — `withGlobalTauri` covers the
core API only, not plugins.

## Out of scope (v1)

- Agent-authored content containing `@alice` does **not** notify. Only the
  raw user turn is scanned. Agents pasting names into their answers would be
  too noisy to enable without a separate confidence heuristic.
- Edit / regenerate does not re-fire mentions. If a user genuinely wants to
  re-ping someone they can type a new turn.
- Username autocomplete in the chat composer. The mention resolver is
  case-insensitive so typing works today; a suggester can be layered on
  later.
- Email / push delivery. In-app + OS-level toasts cover the first-party
  experience; a separate webhook channel is a future addition.

## Consequences

- One new table, three new backend modules, four new frontend components,
  one new Tauri plugin, one new ADR. Net LOC is modest because the fanout
  and SSE primitives are reused from the board-run precedent.
- The subsystem is extension-ready: a future `board.card_assigned` trigger
  is a one-liner against `createNotification` + `fanout.publish`; no schema
  change needed.
- Because `mention_blocked` is aggregated, senders never get a per-user
  spammy list for a private project. The single row carries the full list
  in its body.
- The 200-row cap is a one-knob retention policy. If users complain it's too
  tight, bump the constant.
