# Tasklist

Active tasks for the Bunny project. See [`AGENTS.md`](../../AGENTS.md) for the rules.
Archive lives in [`tasklistarchive.md`](./tasklistarchive.md). Keep at most 50 `done` rows here; move oldest done tasks to the archive when exceeded.

| Status | Related document | Estimated work | Description |
| --- | --- | ---: | --- |
| done | docs/dev/plans/docs-restructure.md | 4h | Restructure `docs/` to match the AGENTS.md layout |
| done | docs/dev/architecture/scheduler.md | 30m | Fix broken paths and registry API in scheduler.md |
| done | docs/dev/architecture/agent-loop.md | 5m | Fix ToolRegistry path (src/tools/registry.ts) |
| done | docs/dev/architecture/queue-and-logging.md | 5m | Fix LogPayload path (src/queue/bunqueue.ts) |
| done | docs/dev/components/component-library.md | 10m | Remove ghost components (DocumentComposer, WhiteboardComposer) |
| done | docs/dev/components/streaming-ui.md | 10m | Fix parseSseFrame reference |
| done | docs/dev/architecture/calendar-and-working-days.md | 5m | Fix non-existent --post-holiday CSS class reference |
| done | docs/dev/architecture/entities/planning.md | 20m | Add left-edge handle; remove "holidays out of v1" stale claim |
| done | docs/dev/components/shell-and-navigation.md | 15m | Add 6 missing tabs to NAV snippet |
| open | docs/dev/follow-ups/docs-check-script.md | 2h | Implement `bun run docs:check` (plans-referenced, max-50-done, job-inventory diff) |
| open | docs/dev/follow-ups/i18n-check-script.md | 2h | Implement `bun run i18n:check` for missing translation keys |
| open | docs/dev/architecture/job-inventory.md | 1h | Populate `job-inventory.md` from `registerAllAgents` / `registerTaxonomyPurgeHandlers` |
| open | docs/dev/follow-ups/job-inventory-test.md | 1h | Add `tests/docs/job-inventory.test.ts` to enforce job-inventory completeness |
