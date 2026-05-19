# ADR 0043 — Planning subsystem (Gantt roadmap with manual lead, advised auto-schedule)

**Status:** accepted
**Date:** 2026-05-08

## Context

Boards (kanban) cover what is happening in any order, but they have no time axis. The user needed a timeline view that lets them lock in real deadlines, attach work items ("wishes") with a working-day duration estimate, link them to teams and tags, express ordering via prerequisite wishes / tags, and see where the schedule snaps under pressure (deadline overrun, missing prerequisites, capacity overload). Multiple planning projects must coexist inside one Bunny project — same shape as Code projects. Per project there's a single Gantt-style roadmap rendered from the user's hand-curated dates plus a single periodically-refreshed "advice" the user can accept or reject in one click.

## Decision

### Sub-application pattern (mirror Code)

Multiple planning projects per Bunny project, each with its own deadlines / teams / tags / wishes / suggestions. Secondary icon rail (`PlanningRail`) mirrors `CodeRail`. Identical localStorage layout (`bunny.activePlanningProject.<bunnyProject>` + `bunny.activePlanningFeature`). This keeps the sub-application contract identical across Code and Planning, so adding a third "sub-app" later (e.g. Finance) follows a known path.

### Append-only schema, 8 tables

`planning_projects`, `planning_deadlines`, `planning_teams`, `planning_team_members` (M:N), `planning_tags`, `planning_wishes`, `planning_wish_tags` (M:N), `planning_suggestions`. Children scope to `planning_project_id` and use `registerTrashable({ scopeColumn: "planning_project_id" })` (the optional override added in ADR 0037 for scripts). Wishes have no UNIQUE constraint on title — titles repeat naturally; soft-delete therefore needs no rename dance.

Dependencies are stored as JSON arrays on the wish row (`depends_on_wishes`, `depends_on_tags`). Tag membership is the M:N table. JSON keeps the schema flat; at typical project sizes (≤ a few hundred wishes) the parse cost is negligible.

### Manual lead — system never silently changes user-approved dates

The user is the source of truth. `planned_start_date` / `planned_end_date` columns on `planning_wishes` are only ever written by the user (form, drag) **or** by an explicitly accepted suggestion. The `planning.suggestion_refresh` scheduler tick runs every 5 minutes and writes only to `planning_suggestions` (replacing the previous pending row); it never touches the wish columns. The "Apply" route copies all suggested dates onto wishes in one click.

This was a hard requirement: planning is a communication artefact. If the system silently nudges dates between conversations, stakeholders lose trust in what they last agreed on. One pending suggestion + one accept-or-reject decision keeps the loop transparent.

### Pure scheduler (`src/planning/scheduler.ts`)

Topological sort (Kahn) over `depends_on_wishes`. For each wish in topo order, compute the earliest start date as `max(prereq end + 1 working day, project start)`, fold in tag prerequisites (the latest end of any wish carrying any required tag name), then walk forward in working days until the wish's team has capacity (`< maxParallel` simultaneous). Reserve `[start, addBusinessDays(start, durationDays - 1)]` in the team's interval list, repeat. Bottlenecks emitted: `cycle`, `tag_unmet`, `deadline_overrun`, `missing_team`.

Working calendar is hard-coded Mon-Fri. Holidays and per-team calendars are out of v1 scope.

### Periodic refresh + on-demand "Generate now"

`planning.suggestion_refresh` cron `*/5 * * * *` walks planning projects whose pending suggestion is missing or whose wish/team/deadline data has changed since the suggestion's `generated_at`. Cap `cfg.planning.suggestionRefreshBatchSize` (default 5) per tick. The on-demand HTTP endpoint reuses `buildAndStoreSuggestion`, just with `generated_by_user_id` populated.

### Notifications

Two new `notifications.kind` values reuse the existing fanout/SSE infrastructure: `planning.wish.assigned` (recipients = members of the team a wish was just bound to, minus the actor) and `planning.deadline.conflict` (team members + project admins, deduped per recipient + wish for `notifyDeadlineConflictDedupMs`, default 24 h). Triggered by route handlers (`POST /wishes`, `PATCH /wishes/:id`, `POST /suggestion/apply`) — never by the scheduler tick.

### Frontend

Custom CSS-grid Gantt — rows = teams + an "Unassigned" lane, columns = working days, wish bars absolute-positioned inside each lane. Drag-to-reschedule snaps to working days (DAY_WIDTH_PX = 32). Vertical lines mark deadlines. The `<PlanningSuggestionPanel>` shows the pending advice as a per-wish before/after diff, accept/reject buttons, and an optional comment textarea. Scrolling and zoom are deliberately minimal in v1.

### Configuration

```toml
[planning]
suggestion_refresh_cron = "*/5 * * * *"
suggestion_refresh_batch_size = 5
notify_deadline_conflict_dedup_ms = 86400000
```

## Consequences

- **Positive:** Plan changes never sneak in. Every shift is either a deliberate user edit or an explicit one-click accept of an advice batch.
- **Positive:** Pure scheduler is small and unit-testable; the same function powers the periodic tick and the on-demand button.
- **Positive:** Append-only schema + soft-delete with `scopeColumn` extension keeps Trash semantics consistent across the app.
- **Neutral:** The Gantt is intentionally simple — no zoom, no resize handles, no dependency arrows in v1. Easy to extend.
- **Negative:** Working calendar is global Mon-Fri. Per-team calendars and holidays will need a follow-up ADR.
- **Negative:** Translation sidecars are not registered — wishes/deadlines stay single-language. Adding `registerKind` calls later is cheap but flagged here so the translator scheduler does not seek them out.

## Out of scope (v2+)

- Drag on deadlines (currently fixed).
- Translation registration for wishes / deadlines / teams / tags.
- Per-team working calendars; holidays.
- iCal / CSV export.
- Dependency arrows overlay on the Gantt (the data exists; rendering is deferred).
- Telegram outbound for deadline-conflict notifications.
- LLM-assisted prose summaries on the executive report (current builder is deterministic).

## Addendum 2026-05-08 — Drag interactions, resize handle, confirmations toggle

Three drag interactions on the Gantt: horizontal (start date), vertical (team reassignment), right-edge handle (duration). All three feed the same `applyDrag` / `applyResize` helpers and are gated by a "Confirm before applying drag changes" checkbox (default ON, persisted in `localStorage["bunny.planningConfirmDrag"]`). On confirm, the route handler patches the wish + auto-calls `/suggestion/generate` so the user immediately sees the ripple effects. Power-mode (checkbox off) skips the confirm dialog for fast iteration.

## Addendum 2026-05-08 — Executive report subsystem

The original v1 Report view only listed bottlenecks. Stakeholders need a complete share-able status snapshot. Added:

- New table `planning_reports` (rolling history, capped at `cfg.planning.maxReportsPerProject`, default 50).
- Pure builder `src/planning/report.ts:buildReportPayload` synthesises seven sections from existing data (summary, deadline status, team workload, risk register, coverage gaps, 14-day upcoming, delta-vs-previous). Markdown renderer in the same file.
- New scheduled handler `planning.report_snapshot` (default cron `0 8 * * 1` — Monday 08:00). Walks alive planning projects with at least one wish; saves a `trigger='scheduled'` row per project; previous payload feeds the comparison block.
- HTTP: `POST /report/generate`, `GET /report/latest`, `GET /reports`, `GET /planning-reports/:id`, `GET /planning-reports/:id/markdown` (returns `text/markdown` with `Content-Disposition: attachment`).
- Frontend Report view rewritten: summary card with status colour rail + completion bar + metric grid, comparison panel, deadline / team / risk tables with severity colour coding, gaps + upcoming sections, snapshot-history dropdown, Markdown export anchor + Print button. Print-friendly `@media print` rules in `styles.css` hide chrome and restore black-on-white so `window.print()` produces a clean PDF.

Builder is deterministic (no LLM calls) — keeps the snapshot reproducible and cheap enough to run on every save.

## Addendum 2026-05-08 — Roadmap UX refinements

Driven by stakeholder feedback on the v1 Gantt:

- **Zoom levels**: Week / Month / Quarter (32 / 14 / 6 px/day). Persisted in `localStorage["bunny.planningRoadmapZoom"]`. Bar widths scale with `dayWidthPx`; deadline lines stay snapped.
- **Auto-extend timeline**: instead of a fixed 60-working-day window from project start, the visible range now covers `min(project_start, all deadline due_dates, all wish planned_start/end_dates)` − 14d to `max(...)` + 14d, floored at 60 working days. Deadlines outside the project start window are always reachable.
- **Conflict overlay**: per team-row, working days where active wish count > `max_parallel` are painted with a red diagonal-stripe overlay; overlapping bars get a red outline + alert icon; the row label adopts a warning glyph. Unassigned lane uses cap = 1.
- **Add wish modal**: a "+ New wish" button on the Gantt toolbar opens the shared `<PlanningWishForm>` in a `<Modal>`. Form was extracted from `PlanningWishesView.tsx` into `web/src/tabs/planning/PlanningWishForm.tsx` so both views reuse the same component.

## Addendum 2026-05-08 — Per-item advice + advice-hide

The original `Apply / Reject` was all-or-nothing. Replaced with a per-item flow:

- **New schema columns** on `planning_wishes`: `advice_hide_start TEXT`, `advice_hide_end TEXT`, `advice_hide_team_id INTEGER`. Migration via `migrateColumns` in `db.ts`. Stores the (start, end, team) tuple of an advice the user has dismissed.
- **Suggestion endpoint enrichment**: `GET /api/planning/:id/suggestion` now splits `payload.placements` into `placements` (visible) and `hiddenPlacements` (matching the wish's stored advice-hide tuple **and** the wish's current `team_id`). The hide auto-expires when any of those values change.
- **New routes**: `POST /api/planning-wishes/:id/advice-hide` (set tuple), `DELETE /api/planning-wishes/:id/advice-hide` (clear). Memory helper `setWishAdviceHide`.
- **UI**: per-item rows with Apply / Hide buttons. Each row shows the diff and inline bottlenecks, plus a "Conflict" badge when the wish appears in any bottleneck. Mode picker (`All` / `Conflicts only`) and `Show hidden` toggle persist in `localStorage`. Bulk Apply all / Reject all buttons remain at the bottom for the legacy workflow.

This decouples the user from one big approval — they can clear noise by hiding non-conflict items, focus on real conflicts, and cherry-pick what to apply.
