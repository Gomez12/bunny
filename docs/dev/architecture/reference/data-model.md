# Data model

SQLite + FTS5 + sqlite-vec. Canonical DDL is `src/memory/schema.sql`. This page groups the tables by domain for orientation.

**Rule: the schema is append-only.** Never drop or rename columns. Add new columns with safe defaults. See [`../getting-started/conventions.md`](../getting-started/conventions.md).

## Events + messages

| Table | Purpose |
| --- | --- |
| `events` | Append-only audit log. Every LLM call, tool call, HTTP mutation. Indexed by `(session_id, ts)` + `(topic, ts)`. |
| `messages` | Conversation history. One row per semantic unit (`channel = content / reasoning / tool_call / tool_result`). Carries `project`, `author`, `attachments`, `edited_at`, `trimmed_at`, `regen_of_message_id`. |
| `messages_fts` | FTS5 virtual table mirroring `content`-channel rows. Trigger-synced. Trigram tokenizer. |
| `embeddings` | vec0 virtual table. Created dynamically at DB open (dimension baked in). |

## Auth

| Table | Purpose |
| --- | --- |
| `users` | Username, argon2id hash, role (`admin` / `user`), display name, email, `preferred_language`. |
| `auth_sessions` | Cookie-backed sessions. Opaque token. |
| `api_keys` | `bny_…` bearer keys. Hash stored; plaintext shown only at mint. |
| `session_visibility` | Per-(user, session): `hidden_from_chat`, `is_quick_chat`, `forked_from_*`. |

## Projects

| Table | Purpose |
| --- | --- |
| `projects` | Name PK, description, visibility, `languages` (JSON), `default_language`. On-disk assets under `$BUNNY_HOME/projects/<name>/`. |

## Agents + skills

| Table | Purpose |
| --- | --- |
| `agents` | Name PK, `is_subagent`, `knows_other_agents`, `context_scope`. On-disk `config.toml`. |
| `project_agents` | Opt-in link. |
| `skills` | Name PK, source_url, source_ref. On-disk `SKILL.md`. |
| `project_skills` | Opt-in link. |

## Boards

| Table | Purpose |
| --- | --- |
| `board_swimlanes` | Columns per project. `auto_run` flag, `default_assignee_*`, `next_swimlane_id`. |
| `board_cards` | Sparse positions (step 100). Assignee is user OR agent (mutex). `archived_at`. |
| `board_card_runs` | Agent run history with `session_id` + `status` + `final_answer`. |

## Scheduler

| Table | Purpose |
| --- | --- |
| `scheduled_tasks` | `kind` = `system` or `user`. Handler name string. Cron expression. `next_run_at`. |

## Content entities

| Table | Purpose |
| --- | --- |
| `documents` | Markdown content. Thumbnail. Translatable + trashable. |
| `whiteboards` | Excalidraw elements JSON + thumbnail. Trashable. |
| `contacts` | JSON arrays for emails / phones / tags. Avatar data URL. Translatable + trashable. |
| `contact_groups` | Per-project named group. |
| `contact_group_members` | Many-to-many. |
| `kb_definitions` | Per-project dictionary. Manual + LLM short/long + sources + SVG. State machine on `llm_status` + `svg_status`. Translatable + trashable. |

## Translations (sidecars)

One per translatable entity. Shape: `(entity_id, lang, <source fields>, status, error, source_version, source_hash, translating_at)`.

| Table |
| --- |
| `kb_definition_translations` |
| `document_translations` |
| `contact_translations` |
| `board_card_translations` |

## Web News

| Table | Purpose |
| --- | --- |
| `web_news_topics` | Self-scheduling topic with agent, terms, `update_cron`, `renew_terms_cron`, `always_regenerate_terms`, `next_update_at`, `next_renew_terms_at`. |
| `web_news_items` | Dedup via `UNIQUE(topic_id, content_hash)`. Bumps `seen_count` on re-sighting. |
| `web_news_topic_subscriptions` | Opt-in Telegram digest subscribers. |

## Notifications

| Table | Purpose |
| --- | --- |
| `notifications` | Per-user cross-project. `kind` = `mention` / `mention_blocked` / future. `deep_link`. Denormalised actor info for post-delete survival. Pruned to newest 200 per user on insert. |

## Telegram

| Table | Purpose |
| --- | --- |
| `project_telegram_config` | One row per project. `bot_token UNIQUE`, transport, webhook secret, `last_update_id`, `poll_lease_until`. |
| `user_telegram_links` | Per-(user, project). `chat_id`, `current_session_id`, `busy_until`. `UNIQUE(project, chat_id)`. |
| `telegram_pending_links` | 15-min TTL one-time pairing tokens. |
| `telegram_seen_updates` | O(1) dedup keyed by `(project, update_id)`. |

## Foreign keys + cascades

- `ON DELETE CASCADE` on: `notifications.user_id`, `auth_sessions.user_id`, `api_keys.user_id`, translation sidecars, `contact_group_members.*`, `board_card_runs.card_id` (via index), `web_news_items.topic_id`, `web_news_topic_subscriptions.*`, Telegram tables' `user_id` / `project`.
- `ON DELETE SET NULL` on: `projects.created_by`, `agents.created_by`, `skills.created_by`, `documents.created_by`, `whiteboards.created_by`, `contacts.created_by`, `kb_definitions.created_by`, `notifications.actor_user_id`, `scheduled_tasks.owner_user_id`.
- Denormalised actor fields (`notifications.actor_username`, `actor_display_name`) preserve the panel after actor deletion.

## Indexes to know

- `idx_events_session`, `idx_events_topic` — Dashboard + Logs queries.
- `idx_messages_session`, `idx_messages_regen_of`, `idx_messages_project` — chat lookups.
- `idx_cards_project`, `idx_cards_assignee`, `idx_cards_agent` — board.
- `idx_sched_due` — scheduler tick.
- `idx_<entity>_trans_pending` — translator scan (WHERE-clause via `(status, source_version)`).
- `idx_<entity>_trash` — partial index on `WHERE deleted_at IS NOT NULL`.
- `idx_notifications_user_unread` — partial index for unread fetch.

## Related

- Canonical DDL: [`src/memory/schema.sql`](../../../src/memory/schema.sql).
- [`../getting-started/conventions.md`](../getting-started/conventions.md) — the append-only rule.
- Each entity page under [`../entities/`](../entities/) — what uses which tables.
