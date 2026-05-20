# Job inventory

Authoritative list of every `job.kind` registered against the scheduler
[`HandlerRegistry`](../../../src/scheduler/handlers.ts). One row per
`registry.register(KIND, …)` call.

There is no umbrella `registerAllAgents` helper. Each domain module exports
its own `register…Handler(registry)` function (e.g. `registerBoardAutoRun`,
`registerPlanningReportSnapshot`). The bootstrap calls them sequentially
against `defaultHandlerRegistry` in
[`src/server/index.ts`](../../../src/server/index.ts) (around lines
202–220), right after the per-`job.kind` `ensureSystemTask` rows are
seeded for each cron cadence.

`bun run docs:check` (see [`../follow-ups/docs-check-script.md`](../follow-ups/docs-check-script.md))
and [`../../../tests/docs/job-inventory.test.ts`](../../../tests/docs/job-inventory.test.ts)
enforce the diff: the set of `registry.register(KIND_HANDLER, …)` calls in
`src/` must equal the set of `job.kind` values in the table below.

## Agents / scheduled tasks

| `job.kind`                          | Registered by                                                                                              | Notes                                                                                                    |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `board.auto_run_scan`               | [`src/board/auto_run_handler.ts:95`](../../../src/board/auto_run_handler.ts)                               | Every 5 min: spawn detached runs for due whiteboards.                                                    |
| `translation.auto_translate_scan`   | [`src/translation/auto_translate_handler.ts:270`](../../../src/translation/auto_translate_handler.ts)      | Every 5 min: translate pending sidecar rows across all registered kinds.                                 |
| `translation.sweep_stuck`           | [`src/translation/sweep_stuck_handler.ts:44`](../../../src/translation/sweep_stuck_handler.ts)             | Daily at 03:00: reclaim sidecar rows stuck in `translating`.                                             |
| `session.hide_inactive_quick_chats` | [`src/scheduler/handlers/session_quick_chat.ts:78`](../../../src/scheduler/handlers/session_quick_chat.ts) | Every 5 min: hide Quick Chats inactive past the threshold.                                               |
| `web_news.auto_run_scan`            | [`src/web_news/auto_run_handler.ts:77`](../../../src/web_news/auto_run_handler.ts)                         | Every minute: spawn detached `runTopic` for due `web_news_topics`.                                       |
| `telegram.poll`                     | [`src/telegram/poll_handler.ts:131`](../../../src/telegram/poll_handler.ts)                                | Every minute: short-poll Telegram updates for enabled poll-transport projects.                           |
| `kb.auto_generate_scan`             | [`src/kb/auto_generate_handler.ts:127`](../../../src/kb/auto_generate_handler.ts)                          | Every minute: generate LLM descriptions for new KB definitions.                                          |
| `kb.sweep_stuck`                    | [`src/kb/sweep_stuck_handler.ts:44`](../../../src/kb/sweep_stuck_handler.ts)                               | Every 5 min: reclaim KB rows stuck in `generating`.                                                      |
| `memory.refresh`                    | [`src/memory/refresh_handler.ts:708`](../../../src/memory/refresh_handler.ts)                              | Hourly: merge new facts into project/agent/user memory bodies.                                           |
| `memory.news_soul.refresh`          | [`src/memory/news_soul_refresh_handler.ts:118`](../../../src/memory/news_soul_refresh_handler.ts)          | Every 6 h: distill news reactions into `users.news_soul`.                                                |
| `contact.soul_refresh`              | [`src/contacts/soul_refresh_handler.ts:211`](../../../src/contacts/soul_refresh_handler.ts)                | Cadence per `[contacts] soul_refresh_cron`: refresh per-contact soul via web tools.                      |
| `contact.soul_sweep_stuck`          | [`src/contacts/soul_sweep_stuck_handler.ts:39`](../../../src/contacts/soul_sweep_stuck_handler.ts)         | Every 5 min: reclaim contact rows stuck in `soul_status='refreshing'`.                                   |
| `business.soul_refresh`             | [`src/businesses/soul_refresh_handler.ts:201`](../../../src/businesses/soul_refresh_handler.ts)            | Cadence per `[businesses] soul_refresh_cron`: refresh per-business soul via web tools.                   |
| `business.soul_sweep_stuck`         | [`src/businesses/soul_sweep_stuck_handler.ts:32`](../../../src/businesses/soul_sweep_stuck_handler.ts)     | Every 5 min: reclaim business rows stuck in `soul_status='refreshing'`.                                  |
| `business.auto_build`               | [`src/businesses/auto_build_handler.ts:357`](../../../src/businesses/auto_build_handler.ts)                | Cadence per `[businesses] auto_build_cron`: extract business candidates from contact signals (ADR 0036). |
| `scripts.sync_scan`                 | [`src/scripts/sync_handler.ts:151`](../../../src/scripts/sync_handler.ts)                                  | Cadence per `[scripts] sync_cron`: bidirectional disk-DB sync for code-project scripts.                  |
| `planning.suggestion_refresh`       | [`src/planning/suggestion_refresh_handler.ts:120`](../../../src/planning/suggestion_refresh_handler.ts)    | Cadence per `[planning] suggestion_refresh_cron`: refresh stale planning suggestions.                    |
| `planning.report_snapshot`          | [`src/planning/report_snapshot_handler.ts:132`](../../../src/planning/report_snapshot_handler.ts)          | Cadence per `[planning] report_snapshot_cron`: weekly executive snapshot per planning project.           |
| `versioning.prune`                  | [`src/memory/versioning_prune_handler.ts:33`](../../../src/memory/versioning_prune_handler.ts)             | Daily at 04:00: trim `entity_versions` chain to the configured cap.                                      |
