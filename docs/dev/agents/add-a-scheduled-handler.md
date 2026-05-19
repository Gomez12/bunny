# Add a scheduled handler

## When you need this

You need something to run on a cron — periodic sync, daily cleanup, auto-run scan. The scheduler has no opinion about your domain; register a named handler and seed a system task.

## Steps

1. Write the handler in your domain module (`src/<domain>/<handler>.ts`):
   ```ts
   import type { ScheduledHandlerCtx, ScheduledTask } from "../scheduler/tasks";

   export async function handle(ctx: ScheduledHandlerCtx, task: ScheduledTask) {
     const payload = JSON.parse(task.payload ?? "{}");
     // do the work — idempotent if the task can be retried.
     // Return normally on success; throw to mark last_status = 'error'.
   }
   ```
2. Register the handler (at module load time, or from a `register()` called by `src/server/index.ts`):
   ```ts
   import { registerHandler } from "../scheduler/handler_registry";
   registerHandler("my_domain.scan", handle);
   ```
3. Seed the system task at boot in `src/server/index.ts`:
   ```ts
   import { ensureSystemTask } from "../scheduler/tasks";
   ensureSystemTask(db, {
     id: "system:my_domain:scan",
     handler: "my_domain.scan",
     name: "My domain scan",
     cron_expr: "*/5 * * * *",  // every 5 minutes
     description: "One-liner explaining what this does.",
   });
   ```
4. Write a test that exercises the handler with a fake `ctx` and `task`.

## Rules

- **Idempotent.** A task can be run-now'd while the minute-ticker is firing; an unlucky restart can duplicate a tick. The handler should not break on double-run.
- **Quick.** If the work is slow (>1 s), dispatch a *detached* promise inside the handler and return quickly. The minute-ticker must stay on schedule.
- **Use `setTaskResult` implicitly.** Throw on error; the ticker stamps `last_status = 'error'` + `last_error`. Return normally on success.
- **Don't touch `next_run_at` inside the handler.** The ticker computes it via `computeNextRun(row.cron_expr, now)`.

## Claiming work atomically

If the handler operates on a queue of work (like `board.auto_run_scan` claiming due cards), use a race-safe conditional UPDATE:

```sql
UPDATE <your_table>
SET status = 'running', claimed_at = :now
WHERE id = :id AND status = 'pending';
-- Check rowsAffected — if 0, another worker won the race.
```

See `src/memory/web_news.ts:claimTopicForRun` and `src/memory/board_cards.ts:clearAutoRun` for concrete patterns.

## Validation

```sh
bun test tests/scheduler/<your_handler>.test.ts
```

Then manually in the UI: **Tasks** tab → find the system task → **Run now**. `last_status` should flip green.

## Related

- [`../concepts/scheduler.md`](../concepts/scheduler.md)
- [`../entities/tasks.md`](../entities/tasks.md)
- `src/board/auto_run_handler.ts` — reference example.
- `src/web_news/auto_run_handler.ts` — handler with per-tick concurrency cap.
