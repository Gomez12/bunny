# Tasks (scheduled)

## What it is

Periodic work driven by cron expressions. Two kinds:

- **System** — seeded at boot, owned by the platform. All users see them; only admins modify.
- **User** — created via the UI, owned by a single user. Admin sees all.

Handlers are registered by domain modules via `HandlerRegistry.register`. The scheduler itself knows nothing about boards, translation, KB, or Web News.

See [`../concepts/scheduler.md`](../concepts/scheduler.md) for the subsystem mechanics — this page covers the user-facing entity.

## Data model

```sql
CREATE TABLE scheduled_tasks (
  id             TEXT    PRIMARY KEY,
  kind           TEXT    NOT NULL CHECK (kind IN ('system','user')),
  handler        TEXT    NOT NULL,
  name           TEXT    NOT NULL,
  description    TEXT,
  cron_expr      TEXT    NOT NULL,
  payload        TEXT,                            -- JSON
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

## HTTP API

- `GET /api/tasks` — list. Own tasks + system for users; all for admins.
- `POST /api/tasks` — create (admin for system; any user for user-kind).
- `GET/PATCH/DELETE /api/tasks/:id`.
- `POST /api/tasks/:id/run-now` — invoke the handler immediately (doesn't advance cron). Owner + admin only.
- `GET /api/tasks/handlers` — list registered handler names (for the picker).

## Code paths

- `src/scheduler/tasks.ts` — CRUD, `claimDueTasks`, `setTaskResult`, `runTask`, `ensureSystemTask`.
- `src/scheduler/ticker.ts` — one-per-minute `tick()`.
- `src/scheduler/handler_registry.ts` — `HandlerRegistry`.
- `src/scheduler/cron.ts:computeNextRun`.
- `src/server/scheduled_task_routes.ts`.

## UI

- `web/src/tabs/TasksTab.tsx` — surfaces system + user tasks with toggle/run-now/edit.
- System tasks show a small `[system]` badge and disable the Delete button for non-admins.

## Extension hooks

- **Translation:** no.
- **Trash:** no.
- **Notifications:** no (on the task itself — handlers may emit their own).
- **Scheduler:** this *is* the scheduler surface.
- **Tools:** no.

## Registered system handlers

| Handler | Cron | Module |
| --- | --- | --- |
| `board.auto_run_scan` | `*/5 * * * *` | `src/board/auto_run_handler.ts` |
| `translation.auto_translate_scan` | `*/5 * * * *` | `src/translation/auto_translate_handler.ts` |
| `translation.sweep_stuck` | `0 3 * * *` | `src/translation/sweep_stuck_handler.ts` |
| `web_news.auto_run_scan` | `* * * * *` | `src/web_news/auto_run_handler.ts` |
| `telegram.poll` | `* * * * *` | `src/telegram/poll_handler.ts` |

Each module calls `registerHandler(name, fn)` at import time, then `src/server/index.ts` invokes an idempotent `ensureSystemTask` at boot.

## Permissions

- System tasks: visible to everyone; admin-only to create / modify / toggle.
- User tasks: owner sees + modifies; admin sees + modifies all.
- `run-now`: owner or admin.

## Key invariants

- **Handler is a string name, not an object reference.** This way a missing handler (e.g. after a rename) doesn't crash the ticker — the tick logs an error and moves on.
- **`claimDueTasks` bumps `next_run_at` in the same transaction as SELECT.** Atomic claim — no double-dispatch.
- **Malformed cron parks the row one hour out**, not throws.
- **`ensureSystemTask` is idempotent.** Re-registering at boot doesn't duplicate.

## Gotchas

- Cron is interpreted in the process's local timezone. Containerised deployments should set `TZ` explicitly.
- `run-now` is useful for debugging a handler but doesn't mutate `last_run_at` the same way the ticker does — the pill and next_run_at may briefly look inconsistent.
- A user task with a payload that targets a resource the owner can no longer see (project deleted, agent unlinked) will fail silently inside the handler. Handler authors should catch + setTaskResult('error', ...) with a useful message.

## Related

- [ADR 0011 — Scheduled tasks](../../adr/0011-scheduled-tasks.md)
- [`../concepts/scheduler.md`](../concepts/scheduler.md)
- [`../how-to/add-a-scheduled-handler.md`](../how-to/add-a-scheduled-handler.md)
