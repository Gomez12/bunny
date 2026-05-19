# Notifications and fanout

## At a glance

Per-user (cross-project) notifications. v1 trigger: `@username` mentions inside chat prompts. The subsystem is extension-ready so future triggers (`board.card_assigned`, `task.completed`, …) are a one-liner against `createNotification` + `fanout.publish`.

One table (`notifications`), one scanner, one dispatcher, one in-memory fanout, one user-facing tab plus a bell in the sidebar footer.

## Where it lives

- `src/memory/schema.sql` — `notifications` table with `ON DELETE CASCADE` on the recipient.
- `src/notifications/mentions.ts` — `parseUserMentions` (whole-prompt scanner) and `dispatchMentionNotifications`.
- `src/notifications/fanout.ts` — in-memory `Map<userId, { subscribers, keepalive }>`.
- `src/server/notification_routes.ts` — `GET /api/notifications`, `PATCH …/:id/read`, `POST …/mark-all-read`, `DELETE …/:id`, `GET …/stream`.
- `web/src/hooks/useNotifications.ts` — subscribes to the stream, maintains unread count.
- `web/src/components/NotificationBell.tsx` + `web/src/components/ToastStack.tsx`.
- `web/src/tabs/NotificationsTab.tsx` — two-pane list + detail.

## The scanner

`parseUserMentions(prompt)` walks the whole prompt (unlike `src/agent/mention.ts` which only strips a leading `@agent`). Boundary rule excludes:

- Emails (`foo@bar.com`).
- URLs (`https://x.com/@alice`).
- Path-like `folder/@user`.
- Mentions inside fenced code blocks or inline `` ` `` spans.

Results are deduped lowercase.

## Dispatcher

`dispatchMentionNotifications(db, { userId, prompt, … })`:

1. For each candidate, `getUserByUsernameCI(db, username)`; skip unknown + skip self.
2. For each recipient who **can see** the project — `createNotification(kind='mention', …)` + `fanout.publish` + optional Telegram ping.
3. For each recipient who **cannot see** the project — aggregate one `mention_blocked` row for the sender listing the blocked usernames (makes "why didn't @bob get pinged" debuggable).

Prune the recipient's list to the newest 200 on every insert so the table stays bounded.

## Gating (`mentionsEnabled`)

Only `POST /api/chat` sets `RunAgentOptions.mentionsEnabled = true`. Regenerate, edit-mode handlers, board-card runs, scheduler paths, and Telegram inbound all leave it off. Background work never produces duplicates.

This mirrors `askUserEnabled` from ADR 0026 — domain gating, not scanner-level filtering.

## Leading-@ collision

`handleChat` only strips a leading `@name` when `getAgent(db, name)` actually returns an agent. A username-only leading token flows through to the scanner — so `@alice hi` (where alice is a user, not an agent) does not 404.

## Fanout (in-memory)

```
type FanoutEntry = {
  subscribers: Set<Controller>;
  keepalive: Timer | null;        -- ': ping\n\n' every 25s
};

const fanout: Map<userId, FanoutEntry> = new Map();
```

- **No replay buffer.** Unlike `RunFanout` (board card runs, web news), long-lived streams would bloat the floor. New subscribers just call `GET /api/notifications` for history.
- **Keepalive on first subscriber.** 25s `: ping\n\n` frames. Dropped when the last subscriber leaves.
- **Logout → `closeAllFor(userId)`.** Hangs up every stream for that user across tabs.

## Read state

`PATCH /api/notifications/:id/read` and `POST /api/notifications/mark-all-read` both publish `SseNotificationReadEvent` back into the user's own fanout — other tabs decrement their badge live. `ids: []` means mark-all-read.

Reading another user's notification returns **404**, not 403 — the row's existence stays private.

## SSE events

- `notification_created` — embeds a `NotificationDto`.
- `notification_read` — `{ ids: number[], readAt: number }`. Empty `ids` = mark-all.

See `src/agent/sse_events.ts` for the exact shape.

## Deep-link format

`notification.deepLink` is an app-relative query string:

```
?tab=chat&project=<project>&session=<sessionId>#m<messageId>
```

`web/src/App.tsx` parses this on boot, so external links or reloads jump directly to the referenced conversation. Toast clicks and bell-item clicks use the same link.

## OS toasts

`web/src/lib/osToast.ts` feature-detects `window.__TAURI__` and routes to `@tauri-apps/plugin-notification` on desktop or `window.Notification` in the browser. Permission is requested from the first bell-click (user-gesture requirement). Toasts are suppressed when the user is already viewing the target session.

Tauri registration: `client/src-tauri/Cargo.toml` includes `tauri-plugin-notification`, registered in `lib.rs` with `notification:default` in the capabilities manifest.

## Key invariants

- **Scanner runs once, in the chat handler.** Not inside `runAgent` — it needs the raw prompt before any mention-stripping.
- **`mentionsEnabled` gates the dispatcher.** Background runs don't fire notifications.
- **Bell lives in `.nav__user-row`.** See `web/src/components/Sidebar.tsx`. Putting it elsewhere regresses the collapsed-rail badge visibility.
- **No replay buffer.** The fanout is push-only; history comes from `GET /api/notifications`.

## Gotchas

- A `mention_blocked` row is a sender-side signal. It doesn't notify anyone — it's there so "why didn't @bob get pinged" is debuggable.
- The bell's unread badge polls via SSE, not fetch. If the stream is disconnected (e.g. iframe suspend), the badge is stale until reconnect. `useNotifications` auto-reconnects on visibility change.
- `closeAllFor(userId)` on logout is important — without it, an SSE stream could keep the server-side subscription alive past the user's session.

## Related

- [ADR 0027 — User notifications](../../adr/0027-user-notifications.md)
- [`telegram-integration.md`](./telegram-integration.md) — outbound hook layered on top.
- [`agent-loop.md`](./agent-loop.md) — `mentionsEnabled` gating.
