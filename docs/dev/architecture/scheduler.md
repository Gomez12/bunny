# Scheduler

## At a glance

One generic ticker runs every minute, picks up due rows from `scheduled_tasks`, invokes a named handler, and computes the next `next_run_at` via cron. The scheduler knows nothing about boards, translation, KB, or Web News — each domain module registers its handler with the registry and seeds its system task at boot.

Two kinds of tasks: `system` (admin-managed, seeded at boot) and `user` (created via the UI, owned by a single user).

## Where it lives

- `src/memory/schema.sql` — `scheduled_tasks` table definition.
- `src/memory/scheduled_tasks.ts` — typed CRUD plus `claimDueTasks`, `setTaskResult`, `ensureSystemTask`.
- `src/scheduler/ticker.ts` — one-per-minute `tick()`; exports `startScheduler` and the `SchedulerHandle` (with `tick`, `runTask`, `stop`).
- `src/scheduler/handlers.ts` — `HandlerRegistry` interface plus `createHandlerRegistry()` factory and the `defaultHandlerRegistry` instance.
- `src/scheduler/cron.ts:computeNextRun` — parses 5-field cron, returns next ms.
- `src/server/scheduled_task_routes.ts` — `/api/tasks*`.
- Each domain ships a `registerXxx(registry)` function. Boot wiring lives in `src/server/index.ts` and seeds the matching system task via `ensureSystemTask`. Examples:
  - `src/board/auto_run_handler.ts` → `board.auto_run_scan`
  - `src/translation/auto_translate_handler.ts` → `translation.auto_translate_scan`
  - `src/translation/sweep_stuck_handler.ts` → `translation.sweep_stuck`
  - `src/web_news/auto_run_handler.ts` → `web_news.auto_run_scan`
  - `src/telegram/poll_handler.ts` → `telegram.poll`
  - `src/planning/suggestion_refresh_handler.ts` → `planning.suggestion_refresh`
  - `src/kb/auto_generate_handler.ts` → `kb.auto_generate`
  - `src/businesses/auto_build_handler.ts` → `businesses.auto_build`

## Schema

```sql
CREATE TABLE scheduled_tasks (
  id             TEXT    PRIMARY KEY,
  kind           TEXT    NOT NULL CHECK (kind IN ('system','user')),
  handler        TEXT    NOT NULL,                -- e.g. 'board.auto_run_scan'
  name           TEXT    NOT NULL,
  description    TEXT,
  cron_expr      TEXT    NOT NULL,                -- 5-field cron
  payload        TEXT,                            -- JSON; handler-specific
  enabled        INTEGER NOT NULL DEFAULT 1,
  owner_user_id  TEXT    REFERENCES users(id) ON DELETE SET NULL,
  last_run_at    INTEGER,
  last_status    TEXT,                            -- 'ok' | 'error'
  last_error     TEXT,
  next_run_at    INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
```

## Tick behaviour

```
every minute:
  claimDueTasks(now):
    # one transaction:
    SELECT * FROM scheduled_tasks
      WHERE enabled = 1 AND next_run_at <= :now
      ORDER BY next_run_at ASC;
    UPDATE scheduled_tasks
      SET next_run_at = :now + 60_000, updated_at = :now
      WHERE id IN (...claimed ids);
  # atomic claim — no other tick picks the same row

  for each claimed row:
    try:
      registry.get(row.handler)(ctx)        # ctx exposes db, queue, cfg, task
      setTaskResult(row.id, { status: 'ok',
                              nextRunAt: computeNextRun(row.cron_expr, now) })
    catch err:
      setTaskResult(row.id, { status: 'error',
                              nextRunAt: computeNextRun(row.cron_expr, now),
                              error: err.message })
    # malformed cron → park the row one hour out instead of crashing
```

## Registering a handler

```ts
// src/your_module/handler.ts
import type { HandlerRegistry, TaskHandlerContext } from "../scheduler/handlers.ts";

export const YOUR_MODULE_SCAN = "your_module.scan";

async function yourModuleHandler(ctx: TaskHandlerContext): Promise<void> {
  // ctx: { db, queue, cfg, task }
  // ... do the work, returning void
}

export function registerYourModule(registry: HandlerRegistry): void {
  registry.register(YOUR_MODULE_SCAN, yourModuleHandler);
}

// boot-time (src/server/index.ts):
import { registerYourModule, YOUR_MODULE_SCAN } from "./your_module/handler.ts";
import { ensureSystemTask } from "../memory/scheduled_tasks.ts";

registerYourModule(registry);
ensureSystemTask(db, YOUR_MODULE_SCAN, {
  name: "Your module scan",
  cronExpr: "*/5 * * * *",
  nextRunAt: Date.now(),
});
```

`ensureSystemTask` is idempotent — re-registering a boot-time task doesn't duplicate. It identifies an existing row by `(kind='system', handler)`, so the handler kind must be globally unique.

## Visibility + permissions

- System tasks are visible to everyone via `GET /api/tasks`.
- Only admins can create/modify/toggle system tasks.
- User tasks are owned by their creator. `GET /api/tasks` shows own tasks to users, all to admins.
- `POST /api/tasks/:id/run-now` invokes the handler immediately (without changing the cron schedule) — available to the task's owner or admin.

## Key invariants

- **Atomic claim.** `claimDueTasks` bumps `next_run_at` *in the same transaction* as selecting, so two ticks can't run the same row. Under concurrent ticks (e.g. board auto-run scan dispatched from two server instances), only one wins.
- **Scheduler is domain-ignorant.** No `if (handler === "board.auto_run_scan")` branches in `ticker.ts`. Each domain wires itself in.
- **Malformed cron never crashes the tick.** Park the row one hour out.
- **Handlers are detached-safe.** The ticker doesn't await long-running work inside the tick — for runCard / runTopic, the handler dispatches a detached promise and returns quickly so the minute-timer stays on schedule.

## Gotchas

- `next_run_at` is a UTC Unix ms. The cron expression is interpreted in the process's local timezone — be explicit about this when setting up a system task.
- `ensureSystemTask` respects *existing* rows. Changing a system task's cron via code does not migrate existing DBs; admins must edit via UI or DB patch.
- `setTaskResult` writes `last_status = 'error'` on exceptions. The Dashboard error rate and Tasks tab "last status" pill both read this field.
- If a handler needs to skip a tick without an error (e.g. nothing to do), let it return normally — `last_status = 'ok'` is correct.

## Related

- [ADR 0011 — Scheduled tasks](../decisions/0011-scheduled-tasks.md)
- [`./entities/tasks.md`](./entities/tasks.md) — the Tasks UI.
- [`translation-pipeline.md`](./translation-pipeline.md) — two system handlers live here.
- [`../agents/add-a-scheduled-handler.md`](../agents/add-a-scheduled-handler.md).
