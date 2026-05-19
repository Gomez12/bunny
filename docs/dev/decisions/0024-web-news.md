# ADR 0024 — Web News (v1)

**Status:** Accepted
**Date:** 2026-04-18

## Context

Users want a project to double as a self-curating newsroom: pick an agent, give it one or more *topics* (a subject + search terms + update schedule), and have the agent periodically scour the web and present a deduplicated, template-rendered overview. The pitch from the feature request is explicit — the topic may start without terms, an optional renew-terms cadence can rotate search terms, the agent must deduplicate against what it already found, and multiple topics per project must roll up into a single, attractively rendered overview.

This ADR documents how Web News slots into the existing architecture without duplicating infrastructure.

## Decision

### Reuse the scan-handler pattern, not per-topic scheduled_tasks

Like `board.auto_run_scan`, a single system-handler `web_news.auto_run_scan` ticks every minute, selects due topics, and dispatches `runTopic` per hit. The topic row itself carries `next_update_at`, `next_renew_terms_at`, and `run_status` — the scheduler table stays clean and per-topic cron edits don't have to mirror into `scheduled_tasks`. The alternative (one `scheduled_tasks` row per topic + one row per renew cron) was rejected: it duplicates cron state, creates two tasks per user-facing entity, and drags topic lifecycle into the scheduler CRUD. Boards proved the scan pattern; we reuse it.

### One agent, user-message framing (not `systemPromptOverride`)

`runTopic` calls `runAgent` with `agent: topic.agent` — the topic's designated agent keeps its own system prompt, tool whitelist, and memory scope. The task-specific instructions (dedup list, JSON contract, renew-mode toggle) ride in as the user message. This matches the `call_agent` tool pattern. Using `systemPromptOverride` instead would have nuked the agent's personality and tool whitelist for that run, which was not the user's intent.

Web tools (`web_search`, `web_fetch`) are auto-spliced via `buildRunRegistry` because `cfg.web` is passed through. No custom tool wiring.

### Data model — append-only, two tables

```sql
CREATE TABLE web_news_topics (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  project                   TEXT    NOT NULL,
  name                      TEXT    NOT NULL,
  description               TEXT    NOT NULL DEFAULT '',
  agent                     TEXT    NOT NULL,
  terms                     TEXT    NOT NULL DEFAULT '[]',
  update_cron               TEXT    NOT NULL,
  renew_terms_cron          TEXT,
  always_regenerate_terms   INTEGER NOT NULL DEFAULT 0,
  max_items_per_run         INTEGER NOT NULL DEFAULT 10,
  enabled                   INTEGER NOT NULL DEFAULT 1,
  run_status                TEXT    NOT NULL DEFAULT 'idle',
  next_update_at            INTEGER NOT NULL,
  next_renew_terms_at       INTEGER,
  last_run_at               INTEGER,
  last_run_status           TEXT,
  last_run_error            TEXT,
  last_session_id           TEXT,
  created_by                TEXT    REFERENCES users(id) ON DELETE SET NULL,
  created_at                INTEGER NOT NULL,
  updated_at                INTEGER NOT NULL,
  UNIQUE(project, name)
);

CREATE TABLE web_news_items (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id          INTEGER NOT NULL REFERENCES web_news_topics(id) ON DELETE CASCADE,
  project           TEXT    NOT NULL,
  title             TEXT    NOT NULL,
  summary           TEXT    NOT NULL DEFAULT '',
  url               TEXT,
  image_url         TEXT,
  source            TEXT,
  published_at      INTEGER,
  content_hash      TEXT    NOT NULL,
  seen_count        INTEGER NOT NULL DEFAULT 1,
  first_seen_at     INTEGER NOT NULL,
  last_seen_at      INTEGER NOT NULL,
  created_at        INTEGER NOT NULL,
  UNIQUE(topic_id, content_hash)
);
```

- **`run_status` + conditional UPDATE** is the concurrency guard. `claimTopicForRun` flips `'idle' → 'running'` only when the row is still idle, returning `changes > 0` for the race winner. Mirrors `setLlmGenerating` in KB.
- **`content_hash = sha256(normalizedUrl + normalizedTitle)`** — URLs have their hash, trailing slash, and `utm_*`/`fbclid`/`gclid` params stripped; titles are lowercased + whitespace/punctuation-normalised. A re-run that finds the same story bumps `seen_count` + `last_seen_at` instead of inserting.
- **Denormalised `project` on `web_news_items`** so the overview query (`WHERE project = ? ORDER BY published_at DESC`) avoids a join.
- **Terms are JSON**, matching the existing `contacts.emails`/`skill_sources` pattern. No join table — terms are always read whole.

### Prompt contract

The agent's user message is built by `buildUserMessage` in `src/web_news/run_topic.ts`:
- **Fetch mode** lists current terms, embeds the last 30 items (title + URL + date) as an explicit dedup list, demands a single fenced \`\`\`json\`\`\` block with an `items` array.
- **Renew+fetch mode** (triggered when `terms.length === 0 || alwaysRegenerateTerms || now >= nextRenewTermsAt`) asks the agent to first propose 3–7 high-signal terms, then fetch. Same JSON shape with an extra `improvedTerms` field.
- Parsing is done by `extractNewsJson`, which accepts `\`\`\`json`, bare triple-backtick, or a raw `{...}` block. Mirrors `extractDefinitionJson`.
- Server-side dedup (`upsertNewsItem`) is the safety net — the agent may still echo known items.

### HTTP surface

New file `src/server/web_news_routes.ts`, mounted between kb-routes and workspace-routes:

| Method | Path | Permission |
|---|---|---|
| `GET` | `/api/projects/:p/news/topics` | `canSeeProject` |
| `POST` | `/api/projects/:p/news/topics` | `canSeeProject` (any viewer can create; edits/run gated by `canEditTopic`) |
| `GET` | `/api/projects/:p/news/topics/:id` | `canSeeProject` |
| `PATCH` | `/api/projects/:p/news/topics/:id` | `canEditTopic` |
| `DELETE` | `/api/projects/:p/news/topics/:id` | `canEditTopic` |
| `POST` | `/api/projects/:p/news/topics/:id/run-now` | `canEditTopic` |
| `POST` | `/api/projects/:p/news/topics/:id/regenerate-terms` | `canEditTopic` |
| `GET` | `/api/projects/:p/news/items` | `canSeeProject` |
| `DELETE` | `/api/projects/:p/news/items/:id` | `canEditProject` |

- `run-now` returns **202** and detaches `runTopic` — the frontend polls for completion. This is consistent with the translation v1 choice: we do not yet have a project-room SSE abstraction.
- `regenerate-terms` is a zero-cost flip that sets `next_renew_terms_at = 0`, so the *next* auto-run-scan tick switches into renew-mode. It does not itself trigger a run.
- Every mutation fires `void ctx.queue.log({ topic: "web_news", kind, userId, data })`.

### SSE events (reserved)

`web_news_run_finished` and `web_news_topic_status` are added to `SseEvent` but not yet emitted. They're placeholders for the day we grow a project-scoped SSE stream (same posture as `translation_generated`). Polling every 5 s while any topic is `running` is the v1 stand-in; it stops as soon as all topics idle.

### Frontend

- **`news` nav item** in the **Content** section (after Knowledge Base), icon `Newspaper` via `web/src/lib/icons.ts`.
- **`WebNewsTab`** is a sidebar + main-pane shell. Sidebar: topics with a tri-state status dot (idle / running / error), play / regen / edit / delete per row. Main pane: template renderer + template picker.
- **Templates** live under `web/src/components/news/` as React components keyed by `TemplateId` in a local `TEMPLATES` array. The v1 set is:
  - `NewsTemplateList` — chronological card grid across all enabled topics, topic-name badge per card.
  - `NewsTemplateNewspaper` — masthead + per-topic sections with a hero card and a multi-column rest.
  Adding another template (e.g. magazine, ticker) is a one-file addition: write the component, add an entry to `TEMPLATES`, and render it behind a `template === id` branch. The storage key `bunny.webNews.template` persists the user's choice client-side; making it server-side later is additive.
- **`TopicDialog`** — name / description / agent (fetched from `/api/projects/:p/agents`) / term chips / update cron with presets / renew mode radio (never / every run / scheduled cron) / max-items slider / enabled toggle.

## Rejected / deferred

- **Per-topic scheduled_tasks rows.** See above.
- **Server-side template choice.** Kept client-side for v1; adds one column to `projects` when we need it multi-device.
- **Project-scoped SSE stream.** Reserved types are in place, but polling suffices for v1.
- **Split fetch-agent vs. term-research agent.** The current design uses one agent for both. If users want different personalities per phase, a `terms_agent` column is a cheap future addition.
- **Items TTL.** Items are append-only — old items linger. Pruning is deferred to a later scheduled task (same shape as `session.hide_inactive_quick_chats`).
- **`[web_news]` config block.** No user-tunable knobs in v1; `MAX_CONCURRENT = 3` is baked into `auto_run_handler.ts`. Promote to config once there's a second knob.

## Consequences

- Adding a future fifth piece of per-entity data (like translations) needs one function-call at the end of `createTopic` — the layout already mirrors documents/contacts/kb-definitions.
- Deleting an agent that a topic depends on leaves the topic row with a stale `agent` string; `isAgentLinkedToProject` check in the scan handler skips it and logs `skip` to the queue (same pattern as board auto-run). Topics do not cascade-delete on agent delete because agent names are free-form strings, not FKs.
- Because items dedup on URL+title, a topic that keeps finding the same story will watch `seen_count` climb; the UI could surface a "trending" ranking from that later.
