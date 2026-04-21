# Telegram integration

## At a glance

Per-project Telegram bot integration. Inbound DMs forward to `runAgent` exactly like `/api/chat`; outbound hooks mirror `@mention` notifications, `card_run_finished`, and Web News digests to the recipient's linked Telegram chat — if they have one for that project.

Linking is **per-project** because the bot is. One user can have up to N Telegram links, one per project.

## Where it lives

- `src/memory/schema.sql` — 5 tables: `project_telegram_config`, `user_telegram_links`, `telegram_pending_links`, `telegram_seen_updates`, `web_news_topic_subscriptions`.
- `src/telegram/handle_update.ts` — inbound DM handler + slash commands (`/start <token>`, `/new`, `/reset`, `/help`).
- `src/telegram/poll_handler.ts` — scheduler handler (`telegram.poll`, cron `* * * * *`).
- `src/telegram/webhook_setup.ts` — `applyTransport`, `setWebhook`, `deleteWebhook`, `reapplyAllTransports` at boot.
- `src/telegram/outbound.ts:sendTelegramToUser` — fan-out helper.
- `src/telegram/format.ts:decideFormat` — markdown → HTML subset (Bot API's HTML).
- `src/telegram/rate_limit.ts` — 30/s global + 1/s per chat.
- `src/server/telegram_routes.ts` — public webhook + authenticated admin routes.
- `web/src/tabs/IntegrationsTab.tsx` — admin-only **Integrations** sub-tab under Workspace.
- `web/src/components/TelegramLinkCard.tsx` — user's own link management in Settings → Profile.

## Inbound flow

```
poll / webhook → handle_update.ts
  1. markSeen(project, update_id)      -- dedup via telegram_seen_updates
  2. UPDATE project_telegram_config    -- advance last_update_id BEFORE processing
                                          (poison-message safety)
  3. slash command?                    -- /start, /new, /reset, /help
  4. chat_id → user_id                 -- via user_telegram_links
     unknown chat → canned "please link" reply
  5. per-chat mutex                    -- busy_until, 5-min TTL
  6. rolling current_session_id
  7. runAgent({ askUserEnabled: false, mentionsEnabled: true })
     collectingRenderer buffers content deltas
  8. format + chunk + send             -- 4000 chars, (n/m) prefix;
                                          sendDocument fallback >16 KB
```

v1 is DM-text only. `edited_message` / `channel_post` / `callback_query` / group chats log `message.inbound.unsupported` and reply politely.

## Transport

Two modes, toggled per-project:

- **`poll`** (default). Every minute the handler claims a 50s `poll_lease_until`, calls `getUpdates?timeout=0`, releases the lease.
- **`webhook`** (opt-in). Only available when `BUNNY_PUBLIC_BASE_URL` is set. `applyTransport` calls `setWebhook` / `deleteWebhook` on flip so `getUpdates` and webhook never collide (Telegram returns 409 otherwise).

`reapplyAllTransports` runs at boot to self-heal registrations that drifted while the server was offline.

## Outbound flow

```
sendTelegramToUser(userId, project, content):
  if no user_telegram_link for (userId, project):   silent no-op
  if config.enabled = 0:                            silent no-op
  decideFormat(content) → HTML subset
  rate_limit.acquire(bot_token, chat_id)            -- 30/s + 1/s per chat
  if formatted.length <= 4000:
    sendMessage
  elif formatted.length <= 16 KB:
    chunk at 4000 chars, "(n/m)" prefix, sendMessage each
  else:
    sendDocument (full markdown + metadata)
```

HTML over MarkdownV2: escape rules for MarkdownV2 are a footgun — HTML subset is saner.

## Hook points (surgical, no new abstraction)

- `src/notifications/mentions.ts` — takes optional `telegramCfg`, pings recipient after `createNotification` + `publish`. Only `POST /api/chat` passes `telegramCfg`.
- `src/board/run_card.ts` — pings `card.assigneeUserId` (or the trigger user for agent-assigned cards) after `markRunDone`. Manual self-triggers skip; scheduled runs always ping.
- `src/web_news/run_topic.ts` — pings each subscriber (or the topic creator if none) after the run, with a digest of the *actually inserted* items. A tick that only bumped `seen_count` is silent.

## HTTP surface

- **Public** (mounted before auth middleware):
  - `POST /api/telegram/webhook/:project` — constant-time compare against `webhook_secret` via `crypto.timingSafeEqual`. Always returns 200 (Telegram doesn't retry a deliberate reject). Dispatch is detached so the handshake stays fast.
- **Admin / project-creator** only:
  - `GET/PUT/DELETE /api/projects/:p/telegram`
  - `POST .../telegram/regenerate-webhook-secret`
  - `POST .../telegram/test-send`
  - `GET/PUT /api/projects/:p/news/topics/:id/subscribers` + `POST/DELETE …/subscribers/:userId`
- **User**:
  - `GET/POST /api/me/telegram-links`
  - `DELETE /api/me/telegram-links/:project`

Tokens are masked to last-4 chars on read; webhook secrets are *never* returned after initial write.

## Config

```toml
[telegram]
poll_lease_ms = 50_000
chunk_chars = 4000
document_fallback_bytes = 16_000
public_base_url = ""        # env override: BUNNY_PUBLIC_BASE_URL
```

## Queue logging

`topic: "telegram"`. Common kinds:

- `config.create` / `config.update` / `config.delete`
- `webhook.register` / `webhook.delete` / `webhook.receive` / `webhook.receive.ignored` / `webhook.receive.rejected` / `secret.rotate`
- `poll.tick` / `poll.error`
- `message.inbound` / `message.inbound.unlinked` / `message.inbound.busy` / `message.inbound.unsupported` / `message.inbound.dropped`
- `message.outbound`
- `link.create.pending` / `link.create.confirm` / `link.create.failed` / `link.delete`
- `session.reset`
- `rate_limit` / `error`

Token values are *never* logged — only `tokenTail` (last 4 chars).

## Key invariants

- **Token masking.** Never log or return the full token; `tokenTail` only.
- **Webhook secret is write-only.** Set once, regenerate if leaked, never read back.
- **Advance `last_update_id` before processing.** Poison-message safety.
- **`sendTelegramToUser` is silent on no-link.** Never throws from "user isn't linked".
- **Rate limiting is per-token.** Global 30/s + 1/s per chat_id.

## Gotchas

- Webhook and poll are mutually exclusive at the Telegram API level. Always flip via `applyTransport`, never by editing the DB directly.
- A bot token belongs to one project. `UNIQUE(bot_token)` enforces this. Moving a bot to another project requires a new token (or delete + recreate, which breaks links).
- `BUNNY_PUBLIC_BASE_URL` must be HTTPS with a public cert. Self-signed certs are rejected by Telegram's webhook setup.
- The IntegrationsTab disables the webhook radio when `BUNNY_PUBLIC_BASE_URL` is unset — the operator must set the env var first.

## Related

- [ADR 0028 — Per-project Telegram integration](../../adr/0028-telegram-integration.md)
- [`notifications-and-fanout.md`](./notifications-and-fanout.md) — the @mention hook point.
- [`../entities/integrations.md`](../entities/integrations.md) — UI surface.
