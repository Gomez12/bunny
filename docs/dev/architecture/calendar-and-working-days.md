# Calendar and Working Days

The calendar exceptions subsystem manages which days are working days across five
scopes. It feeds into the planning Gantt (Phase 2) and is queried directly via the
`/api/calendar/working-days` resolver endpoint.

## Scope hierarchy (most-specific wins)

```
user > team > planning-project > project > global > computed default
```

A day not covered by any scope follows the UTC weekday rule: Mon–Fri workable,
Sat–Sun non-working. Weekends are never stored — they are always computed.

Each scope can either add a non-working day (`kind='non_working'`) or explicitly
mark a day as workable (`kind='workable'`), overriding a higher-scope entry.

## Key files

| File | Role |
|------|------|
| `src/memory/calendar.ts` | CRUD, `resolveWorkingDay`, `buildNonWorkingDateSet` |
| `src/server/calendar_routes.ts` | HTTP routes + SSE holiday fetch |
| `src/memory/schema.sql` | `calendar_exceptions` table + indexes |

## Core resolver

`resolveWorkingDay(db, date, ctx)` runs five sequential queries (one per scope,
most-specific first). The first scope that has a live exception for the date wins.
Returns `{ workable, effectiveScope, reason? }`.

`isWorkingDay(db, date, ctx)` is a boolean wrapper.

## Holiday auto-fetch

`POST /api/calendar/global/holidays` (admin only):
- Body: `{ countryCode: "NL", year: 2026 }`
- Triggers `runAgent` with the `calendar.fetch_holidays` prompt (uses web tools)
- Agent returns a `\`\`\`json\`\`\`` block with `[{ date, name }]`
- Route bulk-inserts as `source='auto_holiday'` — keyed on `(date, country_code)`
  so re-fetching replaces stale data without touching manual rows

Country code resolution: `project.holiday_country_code ?? cfg.calendar.countryCode`
(default `"NL"`, set in `[calendar] country_code` in `bunny.config.toml`).

## Planning integration (implemented)

All three callers of `computeSchedule` pre-query calendar exceptions and pass them
as `ScheduleInput.nonWorkingDates?: Set<string>`:

| Caller | File |
|--------|------|
| Scheduler tick | `src/planning/suggestion_refresh_handler.ts` |
| HTTP bottleneck-check | `src/server/planning_routes.ts` (`reportRoute`) |
| Executive report | `src/planning/report.ts` (`buildReportPayload`) |

Horizon: `max(5 years, totalWishDays × 3)` — ensures the scheduler never reaches
dates beyond the pre-queried window. Dates outside the window fall back to the
hardcoded weekend rule.

**Frontend Gantt**: fetches `GET /api/planning/:id/calendar/non-working?from&to`
on load, passes the result to `workingDayRange(start, count, nwd)` so holidays
are excluded from the working-day timeline. Day-header columns that immediately
follow a holiday gap get `.planning-gantt__day--post-holiday` (orange left-border).

`buildNonWorkingDateSet` in `src/memory/calendar.ts` uses a bulk UNION ALL query
across all applicable scopes, resolves priority in memory (user > team > planning
> project > global), and returns a `Set<string>` of ISO dates. Weekends are
always included in the returned set.

## Queue logging

All calendar mutations log under `topic: "calendar"` with kinds:
- `exception.create`
- `exception.update`
- `exception.delete`
- `holidays.fetch` / `holidays.fetch.done`

## Permissions

| Scope | Read | Write |
|-------|------|-------|
| Global | Any authenticated | Admin |
| Project | `canSeeProject` | `canEditProject` |
| Planning | `canSeeProject` | `canEditPlanningProject` |
| Team | `canSeeProject` | `canEditPlanningProject` |
| User | Own user | Own user |
