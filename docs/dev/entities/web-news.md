# Web News

## What it is

Per-project periodic news aggregator. Each topic carries its own agent, a list of search terms, an `update_cron`, an optional `renew_terms_cron` (or `always_regenerate_terms = 1`), and self-scheduling next-run timestamps. The scheduler fires every minute, selects due topics, and dispatches a fetch or a terms-refresh run.

Items dedup per topic via `content_hash = sha256(normalizedUrl + normalizedTitle)` — re-runs of the same story bump `seen_count` + `last_seen_at` instead of inserting a new row.

## Data model

```sql
CREATE TABLE web_news_topics (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  project                   TEXT    NOT NULL,
  name                      TEXT    NOT NULL,
  description               TEXT    NOT NULL DEFAULT '',
  agent                     TEXT    NOT NULL,
  terms                     TEXT    NOT NULL DEFAULT '[]',  -- JSON
  update_cron               TEXT    NOT NULL,
  renew_terms_cron          TEXT,
  always_regenerate_terms   INTEGER NOT NULL DEFAULT 0,
  max_items_per_run         INTEGER NOT NULL DEFAULT 10,
  enabled                   INTEGER NOT NULL DEFAULT 1,
  run_status                TEXT    NOT NULL DEFAULT 'idle',  -- 'idle' | 'running'
  next_update_at            INTEGER NOT NULL,
  next_renew_terms_at       INTEGER,
  last_run_at               INTEGER,
  last_run_status           TEXT,                              -- 'ok' | 'error'
  last_run_error            TEXT,
  last_session_id           TEXT,
  created_by                TEXT    REFERENCES users(id) ON DELETE SET NULL,
  created_at                INTEGER NOT NULL,
  updated_at                INTEGER NOT NULL,
  UNIQUE(project, name)
);

CREATE TABLE web_news_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id       INTEGER NOT NULL REFERENCES web_news_topics(id) ON DELETE CASCADE,
  project        TEXT    NOT NULL,
  title          TEXT    NOT NULL,
  summary        TEXT    NOT NULL DEFAULT '',
  url            TEXT,
  image_url      TEXT,
  source         TEXT,
  published_at   INTEGER,
  content_hash   TEXT    NOT NULL,
  seen_count     INTEGER NOT NULL DEFAULT 1,
  first_seen_at  INTEGER NOT NULL,
  last_seen_at   INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  UNIQUE(topic_id, content_hash)
);
```

Plus `web_news_topic_subscriptions` (many-to-many): optional per-topic Telegram digest subscribers. When no row exists, the digest falls back to the topic creator only.

## HTTP API

- `GET /api/projects/:p/news/topics` — list.
- `POST /api/projects/:p/news/topics` — create.
- `GET/PATCH/DELETE /api/projects/:p/news/topics/:id`.
- `POST .../topics/:id/run-now` — 202 + detached run.
- `POST .../topics/:id/regenerate-terms` — sets `next_renew_terms_at = 0` so the next tick refreshes.
- `GET /api/projects/:p/news/items` — list items (filter by `topicId`, date range).
- `DELETE /api/projects/:p/news/items/:id`.
- `GET/PUT /api/projects/:p/news/topics/:id/subscribers`, `POST/DELETE …/subscribers/:userId` — Telegram digest subscribers.

Mounted between KB routes and workspace routes in `src/server/routes.ts`.

## Code paths

- `src/memory/web_news.ts` — CRUD + `canSeeProject`-style helpers + `claimTopicForRun` + `releaseTopic` + `selectDueTopics` + `upsertNewsItem` + `computeContentHash`.
- `src/web_news/run_topic.ts` — single entry point for running a topic. Mirrors `runCard` in shape.
- `src/web_news/auto_run_handler.ts` — scheduler handler (`web_news.auto_run_scan`, cron `* * * * *`). Per-tick concurrency cap `MAX_CONCURRENT = 3`.
- `src/server/web_news_routes.ts`.

## `runTopic` flow

```
runTopic(topic):
  1. claimTopicForRun(topic)         -- race-safe conditional UPDATE;
                                        lost race → 409
  2. mode = renew vs fetch           -- renew iff terms.length === 0
                                        || always_regenerate_terms
                                        || now >= next_renew_terms_at
  3. hidden session web-news-<uuid>
  4. runAgent({
       agent: topic.agent,           -- preserves agent's own prompt + tools
       webCfg: cfg.web,              -- web tools auto-splice
       silent renderer,
       user message = task + last 30 items as dedup list + mode directive,
     })
  5. Model returns { items, improvedTerms? }
  6. extractNewsJson → upsertNewsItem each; bump seen_count on dup
  7. releaseTopic + computeNextRun → next_update_at, next_renew_terms_at
  8. Telegram digest → subscribers (or creator if no subs)
  try/catch/finally → row never stays 'running'
```

## UI

- `web/src/tabs/WebNewsTab.tsx` — sidebar (topics + status dots + run-now / regen / edit / delete) + main pane (template renderer).
- `web/src/components/TopicDialog.tsx` — create/edit.
- `web/src/components/news/<Template>.tsx` — templates keyed by id in a local `TEMPLATES` map:
  - `list` — chronological grid with per-card topic badge.
  - `newspaper` — masthead + per-topic sections.

Template choice persists as `bunny.webNews.template` in `localStorage`.

v1 polls every 5s while any topic is running. SSE types `web_news_run_finished` / `web_news_topic_status` are reserved for a future project-scoped stream.

## Extension hooks

- **Translation:** no (news items are fetched content, not authored).
- **Trash:** no.
- **Notifications:** Telegram digest via `web_news_topic_subscriptions` (no in-app notification).
- **Scheduler:** yes — `web_news.auto_run_scan` handler + self-scheduling `next_*_at` timestamps.
- **Tools:** no agent tools — the topic's agent consumes web tools via `webCfg`.

## Dedup

`content_hash = sha256(normalizedUrl + normalizedTitle)`. `upsertNewsItem`:

- Hash exists → `UPDATE seen_count = seen_count + 1, last_seen_at = now`.
- Hash new → `INSERT`.

The Telegram digest sends *only the inserted* items per run — a tick that only bumped `seen_count` is silent.

## Key invariants

- **Dedup is hash-based.** Don't rely on URL equality alone — some feeds permute query params.
- **Self-scheduling timestamps.** `next_update_at` and `next_renew_terms_at` are the *only* thing the scheduler reads; the cron is just the generator.
- **`claimTopicForRun` is atomic.** Race-safe across concurrent ticks (concurrency cap `MAX_CONCURRENT = 3` per tick).
- **Terms-refresh vs fetch.** Two modes; the model returns `improvedTerms` in renew mode only.

## Gotchas

- `always_regenerate_terms = 1` is expensive — every run refreshes terms before fetching. Reserve it for topics where terms drift rapidly.
- The last-30-items dedup list in the user message grows the prompt; consider trimming with `max_items_per_run` tightening if the topic is noisy.
- Telegram digests can arrive out-of-order relative to the UI — the polling cadence is 5s, Telegram delivery is near-instant.
- Queue logging uses `topic: "web_news"`.

## Related

- [ADR 0024 — Web News](../../adr/0024-web-news.md)
- [`./boards.md`](./boards.md) — same `runCard`-shaped orchestration.
- [`../concepts/scheduler.md`](../concepts/scheduler.md)
- [`../concepts/telegram-integration.md`](../concepts/telegram-integration.md)
