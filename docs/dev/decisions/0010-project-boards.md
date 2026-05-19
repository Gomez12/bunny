# ADR 0010 — Trello-style boards per project with agent-runnable cards

## Context

Projects already group sessions, agents, and on-disk assets, but there's no
way inside Bunny to track work-in-progress against a project. Users wanted
a Trello-like kanban: configurable swimlanes, drag-and-drop cards, assignees
that are either users or agents, and — uniquely useful for an agent host —
the ability to **execute** a card by handing the title + description to the
assigned agent and seeing the answer back on the card itself. A future
extension to scheduled (cron-style) runs of the same cards is anticipated.

## Decision

Add a first-class **Board** concept that lives strictly under Project (1
board per project), three new append-only tables, a single reusable
orchestrator for executing a card, and a fifth tab in the web UI.

### Scope & data model

- **No separate `boards` table.** Each project implicitly owns one board;
  `project` is the scope key on every board row, mirroring `project_agents`.
  This avoids a useless level of indirection.
- Three new tables (all `IF NOT EXISTS`, append-only):
  - `board_swimlanes(id, project, name, position, wip_limit, ...)` — the
    columns. `position` is sparse (steps of 100) so reordering only writes
    the moved row.
  - `board_cards(id, project, swimlane_id, position, title, description,
    assignee_user_id, assignee_agent, created_by, created_at, updated_at,
    archived_at)`. `assignee_user_id` and `assignee_agent` are mutually
    exclusive (validated in the memory layer); `archived_at` enables soft
    delete.
  - `board_card_runs(id, card_id, session_id, agent, triggered_by,
    trigger_kind, status, started_at, finished_at, final_answer, error)`.
    `trigger_kind` is `'manual'` today and is in place so the future
    scheduler can use the same row shape without a migration.
- `createProject` calls `seedDefaultSwimlanes` (Todo / Doing / Done). The
  board GET handler also seeds them on-demand for legacy projects so
  upgrading installations don't need a one-shot migration.

### Permissions

- **Board view** uses the existing `canSeeProject` gate.
- **Swimlane CRUD** is restricted to admin or `projects.created_by`.
- **Card create** is open to anyone who can see the project (anyone on the
  team can file work).
- **Card patch / move / archive / run** uses `canEditCard`: admin,
  project-owner, card-creator, or the assigned user.
- Agent-assignee validation requires `isAgentLinkedToProject` so a card
  can't be assigned to an agent that isn't actually available in the
  project.

### Card-run flow

- A single function `runCard()` in `src/board/run_card.ts` is the only entry
  point for executing a card. It resolves the agent, creates a
  `board_card_runs` row in `running` state, registers an in-memory
  **fanout**, calls `runAgent` detached (i.e. `void async`), pipes the
  agent's existing SSE renderer into the fanout, and writes the final
  answer back via `markRunDone` when `runAgent` returns. The HTTP route
  returns 202 + `{ runId, sessionId }` immediately so the UI can navigate
  away or open the live stream at leisure.
- The fanout is a `Map<runId, { buffer, subscribers, closed }>`. Every event
  is appended to `buffer` and pushed to current `subscribers`. New
  subscribers replay the buffer first, so opening the stream URL late
  reconstructs the entire run. A 60-second grace timer drops the fanout
  after the run finishes, after which `GET .../stream` returns 409 and the
  UI falls back to `/api/sessions/:id/messages`.
- The same `runCard` function will be invoked by the scheduler in the
  future with `triggerKind: "scheduled"` and `triggeredBy: "scheduler"`.

### SSE event contract

Two new payload types in `src/agent/sse_events.ts`:

```ts
{ type: "card_run_started",  cardId, runId, sessionId }
{ type: "card_run_finished", cardId, runId, status, finalAnswer?, error? }
```

The agent's normal `content`/`reasoning`/`tool_call`/`tool_result`/`turn_end`
events flow through the same fanout unchanged. Single-source-of-truth means
the frontend `web/src/api.ts` picks them up automatically via the shared
`SseEvent` union.

### UI surface

- New "Board" tab between Messages and Whiteboard (originally between Messages and Projects; tab order shifted as more tabs were added).
- Drag-and-drop via **`@dnd-kit`** (core + sortable). PointerSensor with a
  5px activation distance keeps clicks on the in-card buttons working.
  Drops translate to `beforeCardId`/`afterCardId` on `POST /api/cards/:id/move`
  with optimistic UI updates and rollback on error. A keyboard-friendly
  Move-dropdown stays as fallback.
- The card edit dialog hosts a **Run** button (when an agent is assigned)
  plus a **CardRunLog** that lists historical runs, streams the live one,
  and exposes "Open in Chat" deep-links to each run's session.

## Alternatives considered

- **Synchronous run** (HTTP request stays open until `runAgent` finishes,
  SSE in-band) — same shape as `/api/chat`. Rejected: forces the UI to
  babysit the request, breaks board-browse during long runs, and complicates
  the future scheduler that can't keep an HTTP request open at all.
- **External job queue / multi-process worker** for runs — overkill for the
  current single-process bunny binary. The detached-async pattern can be
  swapped for a queue worker when bunny grows multi-process; the public
  `runCard` signature doesn't have to change.
- **Multiple boards per project / per-board metadata** — adds a `boards`
  table and a level of indirection without a concrete need. Deferred.
- **Built-in DnD via HTML5 events** — fragile across touch devices and
  scroll containers. `@dnd-kit` is ~12KB gz, MIT, and battle-tested.
- **Hard FK from `board_*` to `projects(name)` with ON DELETE CASCADE** —
  inconsistent with `project_agents` (which has no FK) and `messages`
  (which keeps NULL projects readable as `'general'`). Skipped to preserve
  the existing append-only / soft-history convention; orphan checks live in
  the memory layer.

## Consequences

- Schema stays append-only; three new tables, zero `ALTER` on existing
  ones.
- The agent loop is reused as-is — no awareness of the board on its side.
  Anything that improves `runAgent` (better tool routing, smarter recall)
  benefits cards automatically.
- The fanout lives in-process. Multi-process bunny will need a real
  pub/sub (Redis, NATS, or a SQLite-backed channel). The `runCard`
  signature is upgrade-safe.
- `trigger_kind` on the run row is the seam for adding scheduled runs
  later: a separate `card_schedules(card_id, cron_expr, agent, enabled)`
  table plus a tick loop calling `runCard({ ..., triggerKind: "scheduled" })`.
- Out of scope for this ADR: WIP-limit enforcement (currently advisory
  only — UI flags overruns but the API still accepts them); per-card
  comments/attachments; bulk import/export.
