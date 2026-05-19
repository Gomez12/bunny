# Boards

## What it is

Per-project Trello-style kanban. One board per project (no separate `boards` table — `project` is the scope key, like `project_agents`). Swimlanes are columns; cards carry a mutually-exclusive assignee (user *or* agent). Agent-assigned cards can be **run** — `runCard` spawns `runAgent` and streams live.

Three append-only tables. Sparse positions (steps of 100) make drag-and-drop reorders cheap.

## Data model

```sql
CREATE TABLE board_swimlanes (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  project                   TEXT    NOT NULL,
  name                      TEXT    NOT NULL,
  position                  INTEGER NOT NULL,
  wip_limit                 INTEGER,
  auto_run                  INTEGER NOT NULL DEFAULT 0,
  default_assignee_user_id  TEXT,
  default_assignee_agent    TEXT,
  next_swimlane_id          INTEGER,
  color                     TEXT,
  lane_group                TEXT,
  created_at                INTEGER NOT NULL,
  updated_at                INTEGER NOT NULL,
  UNIQUE(project, name)
);

CREATE TABLE board_cards (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  project           TEXT    NOT NULL,
  swimlane_id       INTEGER NOT NULL,
  position          INTEGER NOT NULL,              -- sparse, step 100
  title             TEXT    NOT NULL,
  description       TEXT    NOT NULL DEFAULT '',
  assignee_user_id  TEXT,                          -- mutex with assignee_agent
  assignee_agent    TEXT,
  auto_run          INTEGER NOT NULL DEFAULT 0,
  estimate_hours    REAL,
  percent_done      INTEGER,
  original_lang     TEXT,
  source_version    INTEGER NOT NULL DEFAULT 1,
  created_by        TEXT    NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  archived_at       INTEGER
);

CREATE TABLE board_card_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id       INTEGER NOT NULL,
  session_id    TEXT    NOT NULL,
  agent         TEXT    NOT NULL,
  triggered_by  TEXT    NOT NULL,                  -- user.id or 'scheduler'
  trigger_kind  TEXT    NOT NULL,                  -- 'manual' | 'scheduled'
  status        TEXT    NOT NULL,                  -- queued | running | done | error
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  final_answer  TEXT,
  error         TEXT
);

CREATE TABLE board_card_translations (…);          -- see concepts/translation-pipeline.md
```

## HTTP API

Mounted **before** the generic project routes in `src/server/routes.ts` so the specific paths win.

- `GET /api/projects/:p/board` — full board. Each card DTO carries a `latestRunStatus`.
- `POST /api/projects/:p/board/swimlanes` — create swimlane (admin or project creator).
- `PATCH/DELETE /api/projects/:p/board/swimlanes/:id`.
- `POST /api/projects/:p/board/cards` — create card (any project viewer).
- `PATCH /api/cards/:id` — update fields.
- `POST /api/cards/:id/move` — move to swimlane + position (sparse midpoint).
- `POST /api/cards/:id/archive`.
- `POST /api/cards/:id/run` — start a run (manual trigger). Returns `runId`.
- `GET /api/cards/:id/runs` — historical runs.
- `GET /api/cards/:id/runs/:runId/stream` — SSE fanout with replay buffer (60 s grace window after close).

## Code paths

- `src/memory/board_swimlanes.ts` — CRUD + default Todo/Doing/Done seeding on project create.
- `src/memory/board_cards.ts` — CRUD + `canEditCard` + `moveCard` (sparse midpoint logic).
- `src/memory/board_runs.ts` — run CRUD + `clearAutoRun`.
- `src/board/run_card.ts` — single entry point for running a card. Spawns `runAgent` detached, mirrors SSE into an in-memory fanout keyed by `runId`, writes the final answer via `markRunDone`. Pings Telegram.
- `src/board/auto_run_handler.ts` — scheduler handler that dispatches auto-runs (see below).
- `src/server/board_routes.ts` — HTTP surface.
- `src/tools/board.ts:makeBoardTools` — six closure-bound agent tools.

## Agent tools

`makeBoardTools(project, db, userId)` returns six closure-bound tools — project + db + userId baked in so an agent in project "alpha" cannot reach project "beta":

- `board_list` — swimlanes + cards.
- `board_get_card` — one card by id.
- `board_create_card` — create in the specified swimlane.
- `board_update_card` — partial update.
- `board_move_card` — swimlane + position.
- `board_archive_card`.

Spliced into the per-run registry by `buildRunRegistry` in `src/agent/loop.ts`. Listed in `BOARD_TOOL_NAMES` and surfaced via `/api/tools`.

## UI

- `web/src/tabs/BoardTab.tsx` — the tab.
- `web/src/components/BoardColumn.tsx` + `BoardCard.tsx` — rendering.
- `web/src/components/SwimlaneDialog.tsx` + `CardDialog.tsx` — edit dialogs.
- `web/src/components/CardRunLog.tsx` — streams `/api/cards/:id/runs/:runId/stream`; renders historical runs with an "Open in Chat" deep-link to each run's session.
- Drag-and-drop via `@dnd-kit/core` + `@dnd-kit/sortable`. `PointerSensor` with `distance: 5` so in-card buttons still work.

## Extension hooks

- **Translation:** yes — `board_card_translations` sidecar. Source fields: `title`, `description`.
- **Trash:** no (cards use `archived_at`, a separate flow).
- **Notifications:** yes — `card_run_finished` pings the assignee/trigger user via Telegram (see `concepts/telegram-integration.md`).
- **Scheduler:** yes — `board.auto_run_scan` handler.
- **Tools:** six closure-bound tools (see above).

## Permissions

- Board view → `canSeeProject`.
- Swimlane CRUD → admin or `projects.created_by`.
- Card create → any project viewer.
- Card patch / move / archive / run → `canEditCard` (admin / project-owner / creator / user-assignee).

## Auto-run

Swimlanes and cards each carry an `auto_run` flag. Card flag defaults ON when an agent assignee is set. Lane flag is toggled from the column header.

`board.auto_run_scan` system task (cron `*/5 * * * *`) joins both flags, launches `runCard({ triggerKind: "scheduled" })` for every hit, atomically clears the card flag via `clearAutoRun` so a reservation fires exactly once. Registered from `src/board/auto_run_handler.ts`, seeded at boot in `src/server/index.ts`.

## Run fanout

`runCard` creates an in-memory **fanout** keyed by `runId`:

- Streamed events are mirrored into the fanout buffer — a late SSE subscriber replays the whole run.
- After 60 s grace window post-close, the fanout is dropped; clients fall back to `/api/sessions/:id/messages` for history.
- Unlike the notifications fanout (which has no replay buffer), this one does — cards are short-lived and benefit from replay; notification streams are long-lived and would bloat.

## Key invariants

- **One board per project.** No `boards` table.
- **Card assignee is mutually exclusive.** `assignee_user_id` XOR `assignee_agent`.
- **Positions are sparse (step 100).** Midpoint on move. `moveCard` renumbers only when a midpoint can't fit.
- **Board routes mount before generic project routes** in `routes.ts:handleApi` — order matters.
- **`clearAutoRun` is atomic.** Race-safe reservation for scheduled auto-runs.

## Gotchas

- Changing `PointerSensor.distance` breaks in-card buttons — leave at `5`.
- Hidden sessions: a card run creates a session the user shouldn't see in Chat. `session_visibility.hidden_from_chat = 1` handles this. "Open in Chat" from `CardRunLog` un-hides.
- Deleting a swimlane with cards in it isn't supported — move or archive the cards first. The API returns 409 on delete with children.
- `latestRunStatus` on the DTO is computed (not stored) — a sudden spike in card list latency usually points at a missing index on `board_card_runs`.

## Related

- [ADR 0010 — Project boards](../../adr/0010-project-boards.md)
- [`../concepts/scheduler.md`](../concepts/scheduler.md) — `board.auto_run_scan` handler.
- [`../concepts/translation-pipeline.md`](../concepts/translation-pipeline.md) — card translations.
- [`../concepts/telegram-integration.md`](../concepts/telegram-integration.md) — outbound ping on run finished.
