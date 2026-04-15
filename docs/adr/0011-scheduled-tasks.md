# ADR 0011 — Scheduled tasks (first-class scheduler)

## Status

Accepted — 2026-04-15

## Context

Board cards could only be run by a human clicking **Run**. We wanted the board
to start agent work on its own and, more broadly, a generic seam for any kind
of periodic work (data housekeeping, reminders, future user-defined recurring
cards). `bunqueue` is fire-and-forget only — it has no scheduling primitive —
and the server had no periodic loop at all.

## Decision

Introduce a first-class **scheduler subsystem** that is deliberately agnostic
about what it schedules.

- **Table** `scheduled_tasks(id, kind, handler, name, description, cron_expr,
  payload, enabled, owner_user_id, last_run_at, last_status, last_error,
  next_run_at, timestamps)`. `kind` is `'system'` or `'user'`.
- **Handler registry** (`src/scheduler/handlers.ts`) — in-memory map of name →
  callback. Domain modules register themselves; the scheduler never knows
  about boards, agents, etc.
- **Ticker** (`src/scheduler/ticker.ts`) — one `setInterval` at 60s resolution
  so standard 5-field cron expressions map naturally. Each tick
  `claimDueTasks` selects enabled rows with `next_run_at <= now` and bumps
  that column by one minute inside the same transaction so a parallel tick
  can't re-pick a row. After the handler resolves, `setTaskResult` writes the
  real cron-derived next firing time.
- **Board auto-run** lives at `src/board/auto_run_handler.ts` and registers
  itself as `board.auto_run_scan` on server boot. `src/server/index.ts` seeds
  an idempotent system-task row (`*/5 * * * *`) that references it. This
  keeps the scheduler package free of board-specific knowledge.

Two small additive schema changes support the board side:

- `board_swimlanes.auto_run` — lanes opt-in to the scan.
- `board_cards.auto_run` — per-card flag that defaults ON when an agent is
  newly assigned and is atomically cleared at enqueue via `clearAutoRun` so a
  given auto-run reservation fires exactly once.

Permissions:

- System tasks are visible to everyone but only admins may create/modify/
  delete them (and only admins may toggle `enabled`).
- User tasks are owned by their creator; admins see all of them, other users
  see only their own.

## Alternatives considered

- **Extend bunqueue.** Would mean rewriting our queue worker just to get
  delayed-job support; the scheduler is also conceptually distinct (it
  *produces* work, not consumes it).
- **OS-level cron.** Requires external wiring and breaks the portable-binary
  story (`$BUNNY_HOME` is the only persistent surface).
- **Add auto_run straight to `board_cards` without a generic scheduler.**
  Tempting for MVP but closes the door on user-defined tasks (e.g. "spawn a
  card every Monday at 09:00") and on other non-board periodic work.

## Consequences

- A new `/api/tasks*` surface in the HTTP API and a Tasks tab in the web UI.
- The `RouteCtx` gains `scheduler` + `handlerRegistry`. Tests that build the
  ctx manually need to provide stubs.
- Malformed cron expressions don't spin: `computeNextRun` failures fall back
  to "one hour out" so admins can still fix and re-enable.
- Cron resolution is minute-level. Sub-minute scheduling is out of scope.
