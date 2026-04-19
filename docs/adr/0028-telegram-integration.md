# ADR 0028 — Per-project Telegram integration

Status: Accepted — 2026-04-19

## Context

Bunny is only reachable from the web UI or the CLI today. Users want to talk
to their projects' agents from a messenger — the interaction is inherently
conversational, and background signals (notifications, board card-run results,
Web News digests) are exactly the thing you want in your pocket. A Telegram
bot is the pragmatic starting point: free, supported everywhere, good DX for
everyone involved. The integration is designed to slot into the existing
architecture the way Web News (ADR 0024) and user notifications (ADR 0027)
already do — domain-agnostic scheduler, queue-logged events, `runAgent` driven
from a new transport without touching the agent loop.

## Decision

Introduce a per-project Telegram integration with both an inbound and an
outbound channel, gated by a per-(user, project) link so identity stays
consistent with the existing Bunny-user model.

### Core design choices

- **One bot per project.** Each project gets its own `@bot` + token; the
  `chat_id` space is inherently per-token, so there's no need for a global
  identity split. Admins register the bot in Workspace → **Integrations**.
- **Both transports, configurable per project.** Short-polling is the
  default — it works without a public URL, which matters for local and
  self-hosted installs. Webhook is opt-in when `BUNNY_PUBLIC_BASE_URL` is set.
- **Linked users only.** A Telegram chat maps to exactly one Bunny user per
  project, via a one-time `/start <token>` flow. Unknown chats get a canned
  "please link your account" reply. Per-(user, project) linking matches the
  per-project bot model; a user linked to project α does not receive
  project β's pings from a bot they never opted into.
- **Outbound delivery is a best-effort side channel**, never a primary
  notification path. `@mention` pings, `card_run_finished` results, and Web
  News digests fan out to the recipient's Telegram if they have a link for
  the relevant project; otherwise the hook is a silent no-op. SSE notifications
  and in-app toasts remain the canonical paths — Telegram is a *mirror*.

### Schema (append-only)

Five new tables in `src/memory/schema.sql`:

- `project_telegram_config(project PK, bot_token UNIQUE, bot_username,
  transport, webhook_secret, last_update_id, enabled, poll_lease_until,
  timestamps)` — one row per project.
- `user_telegram_links(user_id, project, chat_id, tg_username,
  current_session_id, busy_until, linked_at)` with composite PK
  `(user_id, project)` and UNIQUE `(project, chat_id)`.
- `telegram_pending_links(link_token PK, user_id, project, expires_at,
  created_at)` — one-time pairing tokens, default TTL 15 min.
- `telegram_seen_updates(project, update_id, seen_at)` — O(1) dedup for
  re-delivered updates. Swept every poll tick.
- `web_news_topic_subscriptions(topic_id, user_id, created_at)` — opt-in
  per-topic digest subscribers; absent → falls back to the topic creator.

### Modules

- `src/memory/telegram_config.ts`, `telegram_links.ts`, `telegram_pending.ts`,
  `telegram_seen.ts`, `web_news_subscriptions.ts` — DB CRUD + race-safe
  conditional UPDATEs for `poll_lease_until` and per-chat `busy_until`.
- `src/telegram/client.ts` — typed wrapper around the Bot API (`getMe`,
  `getUpdates`, `sendMessage`, `sendDocument`, `setWebhook`, `deleteWebhook`)
  + `TelegramApiError` with `retry_after` surfaced.
- `src/telegram/rate_limit.ts` — per-token token-bucket limiter (30/s global,
  1/s per chat) so bulk card-run or news fan-out never drops 429s silently.
- `src/telegram/format.ts` — markdown → HTML-subset converter (HTML because
  MarkdownV2's escape rules are a footgun) + chunking for the 4096-char
  `sendMessage` limit + `sendDocument` fallback above 16 KB.
- `src/telegram/collecting_renderer.ts` — a `Renderer` that buffers content
  deltas so `runAgent` can be driven from the polling loop with a non-SSE
  transport.
- `src/telegram/handle_update.ts` — single inbound dispatcher; dedup → advance
  `last_update_id` → slash-command handling (`/start`, `/new`, `/reset`,
  `/help`) → link lookup → per-chat mutex → `runAgent` with
  `askUserEnabled: false` (no interactive UI) and `mentionsEnabled: true`
  (legitimate `@username` pings).
- `src/telegram/outbound.ts` — `sendTelegramToUser` is the one outbound
  entry. Silent no-op when the user has no link or the bot is disabled.
- `src/telegram/linking.ts` — generate + consume one-time pairing tokens.
- `src/telegram/webhook_setup.ts` — lifecycle coupling; flipping transport
  calls `setWebhook`/`deleteWebhook` so polling and webhook never collide
  (Bot API returns 409 on `getUpdates` with a webhook set).
- `src/telegram/poll_handler.ts` — scheduler handler `telegram.poll`, cron
  `* * * * *`. Claims a 50 s lease per project, calls `getUpdates` with
  `timeout=0` (short-poll — simpler than in-process long-polling for v1,
  accepts up-to-60-s latency), dispatches each update, releases the lease.
  Sweeps stale `telegram_seen_updates` (>24 h) on every tick.

### Hook points in existing code

Surgical additions, no new abstraction:

- `src/notifications/mentions.ts` — after `createNotification` + `publish`,
  calls `sendTelegramToUser` if the caller passes `telegramCfg`. Only
  `POST /api/chat` passes it (self-pings are already suppressed by the
  `sender === recipient` check).
- `src/board/run_card.ts` — inside the detached run's success branch, after
  `markRunDone`, pings `card.assigneeUserId` (or the trigger user for
  agent-assigned cards). Manual self-triggers skip the ping; scheduled runs
  always ping.
- `src/web_news/run_topic.ts` — after the items have been upserted, if any
  were newly inserted, dispatches a chunked digest to each subscriber (or
  the topic creator when no explicit subscribers exist). Digest rows come
  from the actual inserted items, not from the raw LLM output.

### HTTP surface

Routes live in `src/server/telegram_routes.ts`.

**Public (mounted before auth middleware):**

- `POST /api/telegram/webhook/:project` — Telegram posts here. Authenticated
  via `X-Telegram-Bot-Api-Secret-Token` compared constant-time against the
  stored `webhook_secret`. Always returns 200 so Telegram doesn't retry on a
  deliberate reject; dedup inside `handleTelegramUpdate` handles real
  duplicates. Dispatch runs detached so the HTTP handshake stays fast
  (accepted trade-off: if the server is stopped mid-update the single
  message is lost — polling has the same property in the other direction,
  and Telegram redelivers unacked updates in poll mode).

**Authenticated:**

- `GET/PUT/DELETE /api/projects/:p/telegram` — config CRUD. Restricted to
  admin or project creator (the bot token is an impersonation capability;
  mirrors swimlane-CRUD, not card-edit). Token is masked to the last 4
  characters on read; the webhook secret is never returned.
- `POST /api/projects/:p/telegram/regenerate-webhook-secret`.
- `POST /api/projects/:p/telegram/test-send` — admin smoke test.
- `GET/POST /api/me/telegram-links`, `DELETE /api/me/telegram-links/:project`
  — per-user pairing token generation and unlinking.
- `GET/PUT /api/projects/:p/news/topics/:id/subscribers` +
  `POST/DELETE …/subscribers/:userId` — subscriber management for news
  digests.

### Web UI

- **Workspace → Integrations** sub-tab (`IntegrationsTab.tsx`): token input
  (password-masked), transport radio (poll/webhook; webhook disabled when
  `BUNNY_PUBLIC_BASE_URL` is unset), enable toggle, test-send form,
  regenerate-secret and disconnect buttons. Webhook URL is displayed
  read-only with a copy button.
- **Settings → Profile** gains a `TelegramLinkCard` that lists the user's
  existing links, lets them pick a project and generate a one-time
  `https://t.me/<bot>?start=<token>` deep-link.
- Web News subscribers management is surfaced via the HTTP API only in v1;
  the richer topic-card UI lands in a follow-up PR once we have real usage
  data on how many subscribers a typical topic gets.

### Runtime config

New `[telegram]` block in `bunny.config.toml`:

```toml
[telegram]
poll_lease_ms           = 50000
chunk_chars             = 4000
document_fallback_bytes = 16384
public_base_url         = ""     # overridden by BUNNY_PUBLIC_BASE_URL
```

Only `BUNNY_PUBLIC_BASE_URL` is exposed as an env var — it's the only value
an operator is likely to need to change per-environment.

### Queue logging

All Telegram activity logs `topic: "telegram"`. Kinds:
`config.create|update|delete`, `webhook.register|delete|receive|receive.ignored|receive.rejected|secret.rotate`,
`poll.tick|error`, `message.inbound|inbound.unlinked|inbound.busy|inbound.unsupported|inbound.dropped`,
`message.outbound`, `link.create.pending|create.confirm|create.failed|delete`,
`session.reset`, `rate_limit`, `error`. Token values are never logged — only
the last 4 chars of the tail.

### Poison-message safety

`last_update_id` advances **before** `handleTelegramUpdate` processes the
update. Combined with `telegram_seen_updates`, a malformed update cannot
wedge the bot: dedup prevents repeat work; advancement prevents
`offset=` from getting stuck below the bad id on the next `getUpdates` call.
The failure-visible path logs `error` so admins see it in Logs.

### Rate limiting

The per-token limiter uses a classic token bucket. Global refill = 30/s,
per-chat refill = 1/s. Polling and webhook setup calls skip the bucket (they
have their own Bot API budget and would starve the bucket). Burst traffic
(batch card-run fanout, news digests to many subscribers) auto-paces; 429
replies from Telegram never reach production when the limiter is honoured.

### v1 scope limits, intentionally

- DM-only. Group chats, channel posts, and `callback_query` are logged as
  `message.inbound.unsupported` and politely declined.
- No inbound attachments. Telegram photos/voice/documents get the same
  "attachments not yet supported" reply.
- No multi-instance HA for polling — a single Bunny instance is assumed.
  The lease column is there so a future lease-based HA is a one-liner.
- No automatic session expiry. A Telegram conversation keeps the same
  Bunny session across days until the user types `/new` or `/reset`.

## Consequences

- Any future outbound channel (email, Slack, Signal, …) now has a reference
  adapter: stateless client, typed wrapper, one outbound entry point, hook
  points colocated with the triggering subsystem rather than threaded through
  a new notification pipeline.
- The "bot token per project" model is inconvenient for operators who want
  a single bot across every project — that's a deliberate rejection because
  a single-bot model needs a `/start <project>` deep-link flow and deeper
  identity plumbing. Revisit if multiple users push for it.
- Polling latency is bounded by the 60 s cron. Moving to in-process
  long-polling (`timeout=20` on a dedicated loop per project with a watchdog
  respawn) is the natural next step if the UX feels sluggish. The leasing
  machinery supports it already.
- Webhook mode exposes a public endpoint. The secret compare is constant-time
  and the handler always returns 200 — the usual webhook hardening caveats
  apply (DDoS, replay) but the attack surface is tiny.
