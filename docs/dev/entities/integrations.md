# Integrations

## What it is

External-service glue. v1 covers:

- **Per-project Telegram bot** — one bot per project; inbound DMs route to `runAgent`; outbound hooks mirror mentions, card-runs, and news digests.
- **API keys** — `bny_…` bearer tokens minted per user, usable by the CLI or any third-party.

The visible tabs are **Workspace → Integrations** (per-project admin) and **Settings → Profile → Telegram link / API keys** (per-user).

## Telegram

Full write-up lives in [`../concepts/telegram-integration.md`](../concepts/telegram-integration.md). This page is the entity-level summary.

### Tables

- `project_telegram_config` — one row per project, `bot_token UNIQUE`, transport (`poll` / `webhook`), webhook secret, `last_update_id`, `poll_lease_until`, `enabled`.
- `user_telegram_links` — per-(user, project), chat_id, `current_session_id`, `busy_until`.
- `telegram_pending_links` — 15-min TTL one-time pairing tokens.
- `telegram_seen_updates` — O(1) dedup swept every 24h.
- `web_news_topic_subscriptions` — opt-in digest subscribers per news topic.

### HTTP surface

- **Public** (mounted before auth):
  - `POST /api/telegram/webhook/:project` — constant-time compare against `webhook_secret`.
- **Admin / project-creator**:
  - `GET/PUT/DELETE /api/projects/:p/telegram`
  - `POST .../telegram/regenerate-webhook-secret`
  - `POST .../telegram/test-send`
  - Web News subscriber management under `.../news/topics/:id/subscribers*`.
- **User**:
  - `GET/POST /api/me/telegram-links`
  - `DELETE /api/me/telegram-links/:project`

### UI

- `web/src/tabs/IntegrationsTab.tsx` — admin-only sub-tab under Workspace. Token input (password-masked), transport radio (webhook disabled when `BUNNY_PUBLIC_BASE_URL` is unset), enable toggle, webhook URL + copy button, regenerate-secret + disconnect buttons, test-send form.
- `web/src/components/TelegramLinkCard.tsx` — Settings → Profile. Lists existing per-project links, generates `https://t.me/<bot>?start=<token>` deep-links.

### Rules

- Tokens are masked to last-4 chars on read (`tokenTail`).
- Webhook secret is write-only — set at registration, regenerate if leaked, never read back.
- One bot per project (`UNIQUE(bot_token)`).
- Linking is per-(user, project). One user may have multiple links across projects.

## API keys

### Table

```sql
CREATE TABLE api_keys (
  id           TEXT    PRIMARY KEY,
  user_id      TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT    NOT NULL,
  key_hash     TEXT    NOT NULL UNIQUE,    -- only the hash is stored
  prefix       TEXT    NOT NULL,           -- for disambiguation in the UI
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER,
  last_used_at INTEGER,
  revoked_at   INTEGER
);
```

### HTTP

- `GET /api/apikeys` — list (own; admin sees all).
- `POST /api/apikeys` — mint. Returns the full key **once** (never again).
- `DELETE /api/apikeys/:id` — revoke (soft: sets `revoked_at`).

### UI

- `web/src/components/ApiKeyList.tsx` — Settings → Profile card. Create, copy-once, revoke.

### Rules

- Keys start with `bny_` so they're recognisable in logs and Authorization headers.
- Mint is one-shot. Losing a key means revoke + re-mint; there is no "reveal" endpoint.
- `last_used_at` is bumped by `authenticate` on every bearer hit.
- Logout has no effect on API keys — they're independent of browser sessions.

## Extension hooks (generic)

- **Translation:** no.
- **Trash:** no (keys are revoked, not deleted; Telegram configs are deleted outright).
- **Notifications:** outbound Telegram hook points live in mention dispatch, `runCard`, `runTopic`. See `../concepts/notifications-and-fanout.md` + `../concepts/telegram-integration.md`.
- **Scheduler:** `telegram.poll` is the system handler for poll-mode transports.
- **Tools:** no agent tools for integrations.

## Key invariants

- **Tokens are never logged in full.** `tokenTail` only.
- **API key mint is one-shot.**
- **Webhook endpoint is mounted before the auth gate.** Getting the order wrong either breaks the webhook or exposes a protected route.
- **Per-project linking.** A user's Telegram link for project A does not work in project B.

## Gotchas

- `BUNNY_PUBLIC_BASE_URL` must be HTTPS with a public cert. Telegram rejects self-signed certs on webhook setup.
- The IntegrationsTab disables the webhook radio when `BUNNY_PUBLIC_BASE_URL` is unset. An operator must set the env var first.
- An admin who deletes a project cascades into `project_telegram_config`. The bot itself (on Telegram's side) becomes orphaned — remember to delete or reassign it.
- Revoked API keys are never purged. If you need to reclaim storage, a scheduled task can hard-delete rows older than N days with `revoked_at IS NOT NULL`.

## Related

- [ADR 0007 — Authentication, users, roles, API keys](../../adr/0007-auth-and-users.md)
- [ADR 0028 — Per-project Telegram integration](../../adr/0028-telegram-integration.md)
- [`../concepts/auth.md`](../concepts/auth.md)
- [`../concepts/telegram-integration.md`](../concepts/telegram-integration.md)
- [`../concepts/notifications-and-fanout.md`](../concepts/notifications-and-fanout.md)
