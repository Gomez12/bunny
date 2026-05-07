# ADR 0038 — Web News: RSS Feeds and Site Monitor

**Date:** 2026-05-07  
**Status:** Accepted  
**Amends:** ADR 0024

## Context

ADR 0024 introduced the Web News subsystem with a single topic type: LLM keyword-search. Users now want to subscribe to RSS/Atom feeds directly and monitor arbitrary pages for content changes, with both types sharing the existing tables and scheduler.

## Decisions

### 1. `topic_type` column, not a new table

Adding `topic_type TEXT NOT NULL DEFAULT 'keyword_search'` to `web_news_topics` (append-only) reuses the existing scheduling machinery (`selectDueTopics`, `claimTopicForRun`, `releaseTopic`, `upsertNewsItem`) without duplication. Three values: `keyword_search` (existing), `rss_feed`, `site_monitor`.

Companion nullable columns: `feed_url`, `site_url`, `last_html_hash`, `last_md_hash`.

### 2. Pure-TS RSS/Atom parser — no new npm dependency

`src/web_news/feed_parser.ts` uses regex/string matching to parse RSS 2.0 and Atom 1.0. This keeps the portable-binary contract (no native Node modules, no compile-time native addons). Coverage: `<item>` / `<entry>` blocks, `<enclosure>`, `media:content`, `media:thumbnail`, CDATA, entity decoding, pubDate / published / updated.

### 3. Feed discovery: 3-step URL probe

`src/web_news/feed_discovery.ts` tries in order:
1. Fetch the URL directly and detect RSS/Atom by content-type or XML root element.
2. Parse HTML `<link rel="alternate" type="application/rss+xml|atom+xml">`.
3. Probe common paths: `/feed`, `/rss`, `/feed.xml`, `/rss.xml`, `/atom.xml`.

A fourth strategy (pattern matching) is purely UI-side: the `FeedDialog` lets users pick a site pattern (e.g. GitHub Releases) and fills in template variables to build the URL, so no runtime HTTP call is needed.

### 4. Site monitor: 3-layer change filter before LLM call

`src/web_news/site_monitor.ts` avoids unnecessary LLM calls via:

- **Layer 1** — SHA-256 of raw HTML vs `last_html_hash`. Unchanged → stop (no network noise, no cost).
- **Layer 2** — `node-html-markdown` converts HTML to Markdown → SHA-256 vs `last_md_hash`. Unchanged → update `last_html_hash` only (caching-breaker like session tokens, ad rotation, timestamp churn). Stop.
- **Layer 3** — Markdown sent to the agent for content extraction. Same JSON contract as `keyword_search` topics; `extractNewsJson` is reused. On success both hashes are updated.

Rationale: Layer 1 is a fast no-op for truly unchanged pages. Layer 2 filters the large class of HTML changes that don't affect visible text. Layer 3 triggers only when content genuinely changed.

### 5. `web_news_feed_patterns` table — seeded via `INSERT OR IGNORE`

A global (non-project-scoped) table of URL templates. Seeded at schema-init time with 12 built-in patterns covering GitHub, Reddit, YouTube, Hacker News, Stack Overflow, Medium, Substack, Dev.to, PyPI. Admins can add custom patterns (`is_builtin = 0`); built-ins are read-only. `INSERT OR IGNORE` makes seeds idempotent on every `openDb` call.

### 6. Agent field required for all topic types

`web_news_topics.agent` is `NOT NULL` in the existing schema (append-only constraint). RSS feed topics do not call the LLM but still carry an agent reference for future optional enrichment and Telegram digest formatting (which calls `buildDigest` and sends to subscribers). Site monitor topics require an agent for layer-3 LLM extraction.

## Consequences

- All three topic types share the `web_news.auto_run_scan` scheduler tick, the `web_news_items` table, and the existing List/Newspaper UI templates.
- `run_topic.ts` branches on `topic.topicType` before the existing keyword-search flow; the existing flow is untouched.
- New routes: `POST /api/projects/:p/news/discover-feed`, `GET|POST /api/news/feed-patterns`, `DELETE /api/news/feed-patterns/:id`.
- Feed parser is tested independently of network; site monitor hash logic tested with in-memory SQLite.
- Binary size unchanged (no new native deps).
