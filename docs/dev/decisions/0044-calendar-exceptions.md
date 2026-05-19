# ADR 0044 — Calendar Exceptions Subsystem

## Status

Accepted (2026-05-08)

## Context

The planning module's scheduler hardcodes Monday–Friday as working days with no support for national holidays, company events, or personal vacation days. This forces every user to mentally subtract holidays from durations and makes Gantt date suggestions incorrect whenever a holiday falls inside a work window.

The system needs a managed calendar that is easy to maintain: admins should be able to auto-populate national holidays via an agent, project managers should add project-wide events, planning coordinators add sprint-specific days, and users track their personal vacation — without any of these groups needing to coordinate.

## Decision

A single `calendar_exceptions` table stores non-working/workable overrides across five scopes: global, project, planning-project, planning-team, and user. A day not covered by any scope follows the default UTC weekday rule (Mon–Fri workable, Sat–Sun non-working).

**Resolution: most-specific scope wins.** Priority: user > team > planning > project > global > computed default. A lower scope can both add a non-working day AND override a higher-scope non-working day back to workable (e.g. a user marks a national holiday as a workable day because they choose to work it).

**No weekend storage.** Saturdays and Sundays are computed (`date.getUTCDay()`) — never stored. The table only holds exceptions to the weekday default.

**Holiday auto-fetch.** Admin triggers an SSE endpoint (`POST /api/calendar/global/holidays`) that runs a `runAgent` call with the `calendar.fetch_holidays` prompt (scope: global). The agent uses `web_search` + `web_fetch` to fetch official national holidays for a country+year, returns a single fenced JSON block, and the route bulk-inserts them as `source='auto_holiday'`. Auto-holiday rows are keyed by `(date, country_code)` so re-fetching the same year replaces stale data without touching user-created manual rows.

**Country code layering.** Global default is `cfg.calendar.countryCode` (TOML `[calendar] country_code`, default `"NL"`). Projects can override via `projects.holiday_country_code`. The route resolves: `project.holiday_country_code ?? cfg.calendar.countryCode`.

**Phase 2 (not yet implemented).** The `buildNonWorkingDateSet(db, fromDate, toDate, ctx)` helper pre-queries all applicable exceptions for a date range and returns a `Set<string>`. When wired into `computeSchedule` via a new `nonWorkingDates?: Set<string>` field on `ScheduleInput`, the scheduler stays DB-free — callers pre-query before scheduling.

## Schema

```sql
CREATE TABLE calendar_exceptions (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  date                 TEXT    NOT NULL,  -- ISO YYYY-MM-DD
  kind                 TEXT    NOT NULL CHECK (kind IN ('non_working', 'workable')),
  name                 TEXT    NOT NULL DEFAULT '',
  source               TEXT    NOT NULL DEFAULT 'manual',
  country_code         TEXT,
  project_name         TEXT    REFERENCES projects(name) ON DELETE CASCADE,
  planning_project_id  INTEGER REFERENCES planning_projects(id) ON DELETE CASCADE,
  planning_team_id     INTEGER REFERENCES planning_teams(id) ON DELETE CASCADE,
  user_id              TEXT    REFERENCES users(id) ON DELETE CASCADE,
  created_by           TEXT    REFERENCES users(id) ON DELETE SET NULL,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  deleted_at           INTEGER,
  deleted_by           TEXT
);
```

Per-scope unique partial indexes prevent duplicate entries within the same scope while allowing different scopes to have entries for the same date. Soft-deleted rows don't block re-adds.

`projects.holiday_country_code TEXT` is added via `migrateColumns`.

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/calendar/global` | List global exceptions |
| POST | `/api/calendar/global` | Create global exception (admin) |
| POST | `/api/calendar/global/holidays` | SSE: agent-fetch holidays (admin) |
| PATCH/DELETE | `/api/calendar/global/:id` | Update/delete (admin) |
| GET/POST | `/api/projects/:p/calendar` | Project exceptions |
| PATCH/DELETE | `/api/projects/:p/calendar/:id` | Update/delete project exception |
| GET/POST | `/api/planning/:id/calendar` | Planning exceptions |
| GET/POST | `/api/planning-teams/:id/calendar` | Team exceptions |
| GET/POST | `/api/users/me/calendar` | Personal user exceptions |
| GET | `/api/calendar/working-days` | Resolve a date: `{ workable, effectiveScope, reason? }` |

## Consequences

- National holidays are maintained by one person (admin) via an agent and apply everywhere — no per-user burden.
- Project managers can block company events without affecting the global calendar.
- Users have full control over their personal calendar without needing admin assistance.
- The Gantt scheduler remains a pure function until Phase 2 wires in `buildNonWorkingDateSet`.
- Adding `holiday_country_code` to `projects` is append-only per convention.
- Auto-holiday rows and manual rows coexist on the same date — re-fetching holidays never erases manual overrides.
