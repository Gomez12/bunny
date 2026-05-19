# Planning

Per-Bunny-project sub-application that groups deadlines, teams, tags, and "wishes" (work items) onto a Gantt-style roadmap. Multiple planning projects coexist inside one Bunny project — same shape as Code projects.

The user is in lead. The system never silently changes user-approved dates. It produces one *pending* schedule advice the user accepts or rejects in one click.

See [ADR 0043](../../decisions/0043-planning-subsystem.md).

## Tables

| Table | Purpose | Soft-delete scope |
|---|---|---|
| `planning_projects` | Parent. `UNIQUE(project, name)`. | `project` (default) |
| `planning_deadlines` | Fixed end-dates inside a planning project. | `planning_project_id` |
| `planning_teams` | Execution units with a `max_parallel` capacity. | `planning_project_id` |
| `planning_team_members` | M:N to `users`. Optional, only used for notifications. | — |
| `planning_tags` | First-class tags inside a planning project. | `planning_project_id` |
| `planning_wishes` | Work items: title, duration, team, deadline, dependencies, optional `jira_key` external tracker reference. No UNIQUE; no rename-on-delete. | `planning_project_id` |
| `planning_wish_tags` | M:N between wishes and tags. | — |
| `planning_suggestions` | At most one `pending` row per planning project (UNIQUE partial index). | — |
| `planning_reports` | Snapshot history of executive-grade status reports (rolling window, default 50 rows). | — |

Dependencies: `planning_wishes.depends_on_wishes` (JSON array of wish ids) and `depends_on_tags` (JSON array of tag names — every wish carrying any listed tag must finish first).

## Scheduler (`src/planning/scheduler.ts`)

Pure function. Inputs: `startDate`, wishes, teams, deadlines, tags. Outputs: `placements[]` + `bottlenecks[]`.

Algorithm:
1. Topological sort (Kahn) over `depends_on_wishes`. Cycles → emit `cycle` bottlenecks, skip placement.
2. For each wish in topo order:
   - `earliest = max(prereq end + 1 working day, project start)`.
   - Add tag prerequisites: latest end of any wish carrying any required tag.
   - `team_available_at` = next working day where the team has < `maxParallel` active wishes.
   - `start = max(earliest, team_available_at)`.
   - `end = addBusinessDays(start, durationDays - 1)` (Mon-Fri only; weekends skipped).
   - Reserve `[start, end]` in the team's interval list.
   - If the wish has a deadline and `end > deadline.due_date`, emit a `deadline_overrun` bottleneck.

Working calendar: Mon-Fri. Per-team calendars and holidays are out of v1 scope.

## HTTP routes (`src/server/planning_routes.ts`)

Two prefix families:

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/projects/:project/planning` | List planning projects |
| POST | `/api/projects/:project/planning` | Create |
| GET / PATCH / DELETE | `/api/planning/:id` | Get / update / soft-delete |
| GET / POST | `/api/planning/:id/{deadlines,teams,tags,wishes}` | List + create child |
| PATCH / DELETE | `/api/planning-{deadlines,teams,tags,wishes}/:id` | Update / soft-delete child |
| POST / DELETE | `/api/planning-teams/:id/members[/:userId]` | Add / remove team members |
| POST | `/api/planning/:id/suggestion/generate` | Recompute pending advice |
| GET | `/api/planning/:id/suggestion` | Latest pending advice |
| POST | `/api/planning/:id/suggestion/apply` | Copy dates → wishes (one click) |
| POST | `/api/planning/:id/suggestion/reject` | Mark rejected with optional comment |
| GET | `/api/planning/:id/report` | Bottlenecks against current planned dates |

Auth: `canSeeProject` for reads, `canEditProject` / `canEditPlanningProject` for mutations.

## Suggestion lifecycle

1. **Periodic tick** — `planning.suggestion_refresh` (cron `*/5 * * * *`) walks planning projects whose pending suggestion is missing or whose wish/team/deadline data has changed since the suggestion's `generated_at`. Up to `cfg.planning.suggestionRefreshBatchSize` per tick. Writes only to `planning_suggestions` — never to wish columns.
2. **On-demand** — `POST /api/planning/:id/suggestion/generate` reuses `buildAndStoreSuggestion`, just with `generated_by_user_id` set.
3. **Accept** — `POST /.../suggestion/apply` calls `applyPlacements` (transactional bulk update of wish columns) and flips the suggestion's `status` to `accepted` with the optional comment + `decided_by_user_id`.
4. **Reject** — `POST /.../suggestion/reject` only flips the status; wish columns stay untouched. Comment is preserved for next-round context.

## Notifications

Two new `notifications.kind` values, no schema migration (the column is freeform TEXT):

| Kind | When | Recipients |
|---|---|---|
| `planning.wish.assigned` | A wish's `team_id` changes from null/old → new | Members of the new team minus the actor |
| `planning.deadline.conflict` | After a mutation, a wish with a deadline has `planned_end_date > deadline.due_date` | Team members + project admins, deduped per recipient + wish for `cfg.planning.notifyDeadlineConflictDedupMs` (default 24 h) |

Triggered from route handlers only (`POST /wishes`, `PATCH /wishes/:id`, `POST /suggestion/apply`). The scheduler tick never fires notifications.

## Frontend

| File | Purpose |
|---|---|
| `web/src/tabs/PlanningTab.tsx` | Shell: active project + active feature; localStorage `bunny.activePlanningProject.<bunnyProject>` and `bunny.activePlanningFeature` |
| `web/src/components/PlanningRail.tsx` | Secondary icon rail (mirrors `<CodeRail>`) |
| `web/src/components/PlanningProjectDialog.tsx` | Create / edit dialog |
| `web/src/components/PlanningProjectPickerDialog.tsx` | Pick / new / edit / delete |
| `web/src/tabs/planning/PlanningRoadmapView.tsx` | Custom CSS-grid Gantt (rows = teams, columns = working days). Drag-to-reschedule, deadline lines, suggestion panel below |
| `web/src/tabs/planning/PlanningWishesView.tsx` | List + form (title, description, duration, team, deadline, tags multiselect, prereq wishes + tags) |
| `web/src/tabs/planning/PlanningDeadlinesView.tsx` | List + form |
| `web/src/tabs/planning/PlanningTeamsView.tsx` | List + form (incl. members) |
| `web/src/tabs/planning/PlanningTagsView.tsx` | List + form |
| `web/src/tabs/planning/PlanningReportView.tsx` | Bottlenecks against the current user-approved planned dates |
| `web/src/tabs/planning/PlanningSuggestionPanel.tsx` | Shared component shown in Roadmap. Diff view + accept/reject buttons + comment textarea |
| `web/src/lib/planningDates.ts` | Working-day helpers (mirror `src/planning/scheduler.ts`) |

The Gantt bar supports three drag interactions. All three feed the same `applyDrag` / `applyResize` helpers, gated by the **Confirm before applying drag changes** checkbox in the top-left toolbar (default ON, persisted at `localStorage["bunny.planningConfirmDrag"]`).

| Interaction | Snap | What changes |
|---|---|---|
| Bar body, horizontal | One working day per `DAY_WIDTH_PX` | `planned_start_date` (and derived `planned_end_date`) |
| Bar body, vertical | One row per `ROW_HEIGHT_PX` | `team_id` — drag onto another team's row, or onto the "Unassigned" lane |
| Right-edge handle | One working day | `duration_days` (and derived `planned_end_date`) |

When confirmations are enabled, releasing the pointer opens a `<ConfirmDialog>` listing every change about to be written ("Start date: X → Y", "Team: A → B", or "duration N → M"). On confirm: PATCH the wish + auto-call `/suggestion/generate` so the user immediately sees the ripple effects (downstream wishes, deadline conflicts) without a second click. When confirmations are off the dialog is skipped — drag-and-drop applies straight away.

### Zoom + auto-extend timeline

The toolbar has a zoom switch (Week / Month / Quarter — 32 / 14 / 6 px per working day, default Week, persisted in `localStorage["bunny.planningRoadmapZoom"]`). **Mouse wheel** over the Gantt grid cycles zoom levels (throttled to ~150 ms per step); hold Shift / Ctrl to bypass and scroll normally. The timeline range is **derived** from project start + every deadline + every wish's `planned_start/end_date`, with a 14-day buffer on each side and a 60-working-day floor. Deadlines outside the project's start window (e.g. a January launch when the project starts in May) are always visible without manual scrolling.

### Edit a wish from the Roadmap

Double-click any bar to open the edit modal — same `<PlanningWishForm>` as the "+ New wish" button, pre-filled with the wish's current values. Single-click + drag still moves; the bar's drag handler ignores zero-delta releases so a click+release without movement does not patch.

### Sprint indicators

Each planning project carries an optional `sprint_duration_days` setting (in working days; 5 = weekly, 10 = bi-weekly, etc.). When set, the Roadmap renders a thin sprint band between the week and day-number rows: each sprint span shows its label (`S1`, `S2`, …) on a faintly tinted background that alternates per sprint. Inside each lane, a subtle dashed vertical line marks each sprint boundary. Sprints align to `start_date`; the buffer area before the project start has no sprint band. Set the field via the planning-project edit dialog — leaving it empty / 0 disables the indicators.

### Conflict overlay

When a team's working days hold more wishes than the team's `max_parallel`, the lane paints those days with a red diagonal-stripe overlay and every overlapping bar gets a red outline + alert icon. The row label gains a small alert icon summarising "N wish(es) overlap beyond capacity". The Unassigned lane treats the cap as 1.

### Add wish from the Roadmap

The toolbar's "+ New wish" button opens a modal hosting the shared `<PlanningWishForm>` (also used by the Wishes view). On save the roadmap reloads — new scheduled wishes appear in their team-row, unscheduled ones in the bottom pane.

## Schedule advice — per-item flow

The advice panel is per-item: each proposed change is its own row with a wish title, a current → suggested diff, and three buttons:

- **Apply** — PATCH `plannedStartDate` / `plannedEndDate` immediately for that wish only. The pending suggestion stays around; the next refresh tick replaces it.
- **Hide** — sets `(advice_hide_start, advice_hide_end, advice_hide_team_id)` on the wish to the proposed values. The server filters that placement into a separate `hiddenPlacements` array on subsequent `/suggestion` reads. Hide auto-expires the moment the wish's team changes or the scheduler proposes different dates.
- **Apply all** / **Reject all** at the bottom keep the bulk-decision workflow.

The panel header has a **mode picker**:

- **All** — every advised change in the visible list (default).
- **Conflicts only** — only changes whose wish appears in a current bottleneck (`deadline_overrun`, `cycle`, `tag_unmet`, `missing_team`). Useful when the user has agreed an existing plan and only cares about advice that resolves a real conflict (e.g. vacation gaps, deadline misses).

A **Show hidden** toggle reveals previously-hidden items in a collapsed `<details>` block; each hidden row gets an Unhide button that clears the `advice_hide_*` tuple. Mode + show-hidden state persist in `localStorage["bunny.planningSuggestionMode"]` / `bunny.planningSuggestionShowHidden`.

## Executive reports

The Report sub-tab shows an executive-grade roadmap status snapshot per planning project. Sections:

| Section | Source |
|---|---|
| **Executive summary** | Counts (wishes done / in progress / planned / unscheduled), completion %, deadline counts, overall status (`on_track` / `at_risk` / `slipping` / `no_data`), one-line headline + paragraph for skim-reading. |
| **Comparison vs. previous snapshot** | Δ wishes done, Δ unscheduled, Δ deadlines at risk, new vs. resolved risks. Skipped on the first snapshot. |
| **Deadlines** | Per deadline: due date, status, days until, linked wishes (done / at-risk / total), worst overrun in days. |
| **Team workload** | Per team: members, capacity, active / queued / done / unscheduled wish counts, open work in days, estimated working days at current capacity, earliest free date. |
| **Risks** | Severity-ranked. Drawn from the scheduler bottlenecks (`deadline_overrun`, `cycle`, `tag_unmet`, `missing_team`) plus direct checks (`no_team`, `no_deadline`, `no_start_date`). |
| **Coverage gaps** | Wishes without a team / deadline / start date, deadlines without linked wishes, unused tags, teams without members. |
| **Upcoming (next 14 days)** | Deadlines, wishes starting, wishes finishing — all dated and team-attributed. |

Each generation is saved to `planning_reports` with the structured payload + a markdown rendition + a one-line `headline`. The picker shows the rolling history (cap `cfg.planning.maxReportsPerProject`, default 50). The user can:

- **Generate now** — `POST /api/planning/:id/report/generate` — synthesises a fresh snapshot, runs the scheduler with manual locks, and saves the row. Auto-prunes the oldest rows beyond the cap.
- **Markdown export** — `GET /api/planning-reports/:id/markdown` — returns the saved markdown with `Content-Disposition: attachment; filename="roadmap-report-<name>-<timestamp>.md"`. Distributable to executives without further editing.
- **Print** — `window.print()` triggers a print-friendly stylesheet (`@media print` rules in `styles.css`) that hides toolbars, restores black-on-white, and lets the user save as PDF via the OS dialog.

A scheduled handler `planning.report_snapshot` (default cron `0 8 * * 1` — Monday 08:00) walks every alive planning project that has at least one wish and saves a `trigger='scheduled'` snapshot. Empty projects are skipped. The previous snapshot's payload feeds the comparison block, so a Monday-morning report always shows "since last week" deltas.

Routes:

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/planning/:id/report/generate` | Manual snapshot, returns the saved row |
| GET | `/api/planning/:id/report/latest` | Most recent saved snapshot or `null` |
| GET | `/api/planning/:id/reports` | History list (lightweight, no payload) |
| GET | `/api/planning-reports/:id` | Full saved snapshot with payload + markdown |
| GET | `/api/planning-reports/:id/markdown` | Markdown download (text/markdown) |

The pure builder lives in `src/planning/report.ts:buildReportPayload` so the same code path serves both the route handler and the scheduled handler. The markdown renderer is in the same file (`renderReportMarkdown`).

## Configuration

```toml
[planning]
suggestion_refresh_cron = "*/5 * * * *"
suggestion_refresh_batch_size = 5
notify_deadline_conflict_dedup_ms = 86400000
report_snapshot_cron = "0 8 * * 1"
report_snapshot_enabled = true
max_reports_per_project = 50
```

## Queue topic + kinds

Topic `planning`. Kinds (non-exhaustive):
`project.create`, `project.update`, `project.delete`,
`deadline.create`, `deadline.update`, `deadline.delete`,
`team.create`, `team.update`, `team.delete`, `team.member.add`, `team.member.remove`,
`tag.create`, `tag.update`, `tag.delete`,
`wish.create`, `wish.update`, `wish.delete`,
`suggestion.generate`, `suggestion.apply`, `suggestion.reject`, `suggestion.refresh`,
`report.generate`, `report.snapshot`, `report.snapshot.error`,
`notification.assigned`, `notification.deadline_conflict`.

## Out of scope (v2+)

- Drag on deadlines (currently fixed once set).
- Translation registration on wishes / deadlines / teams / tags.
- Per-team working calendars; holidays.
- Resize handles on Gantt bars (duration is edited via the wish form).
- iCal / CSV export.
- Dependency arrows overlay on the Gantt.
- Telegram outbound for deadline-conflict notifications.
