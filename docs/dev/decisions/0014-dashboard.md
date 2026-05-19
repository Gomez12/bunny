# ADR 0014 — Dashboard Tab

## Status

Accepted — 2026-04-16

## Context

Bunny's web UI provided individual views for chat, messages, boards, files,
tasks, projects, agents, skills, logs, and settings — but no unified
overview. Users opening the app had no at-a-glance summary of system
activity, token usage, error rates, or agent performance.

The database already records rich telemetry: `messages` rows carry
timestamps, token counts, durations, tool names, agent authors, and project
scopes; `events` rows log every queue job with topic/kind/error; board
tables track card status and run results; the scheduler table exposes task
health.

## Decision

### Single endpoint

A new `GET /api/dashboard?range=24h|7d|30d|90d|all` endpoint returns all
dashboard data in one JSON response. SQLite queries are synchronous on a
single connection, so splitting into multiple endpoints would only create
client-side waterfall with no server-side parallelism benefit. The response
is typically under 10 KB.

### Charting library

Recharts was chosen over Chart.js (via react-chartjs-2), uPlot, and Tremor:

- React-native composable API (JSX components, not imperative canvas)
- Tree-shakeable — only imported chart types ship in the bundle
- Dark-theme support via inline props (no global CSS override needed)
- Wide chart type variety: AreaChart, BarChart, PieChart, LineChart
- Estimated bundle addition: ~120 KB gzipped

### User scoping

Admin users see global statistics across all users. Non-admin users are
automatically filtered to their own data via `user_id`. Board overview and
scheduler health are unscoped (project-level visibility is already handled
elsewhere).

### Database indexes

Two new indexes were added in `migrateColumns` to support efficient
time-range aggregation:

- `idx_messages_ts ON messages(ts)` — bare timestamp for dashboard queries
  that aggregate across all sessions/projects.
- `idx_events_ts ON events(ts)` — same for the events table.

Both follow the existing `CREATE INDEX IF NOT EXISTS` pattern.

### Tab placement

Dashboard is the first tab button in the navigation bar for visibility, but
the default landing tab remains "chat" (or whatever the user last used, as
persisted in localStorage).

## Consequences

- New dependency: `recharts` in `web/package.json`.
- New files: `src/memory/stats.ts`, `src/server/dashboard_routes.ts`,
  `web/src/tabs/DashboardTab.tsx`.
- Modified files: `src/memory/db.ts` (indexes), `src/server/routes.ts`
  (wire route), `web/src/App.tsx` (tab), `web/src/styles.css` (dashboard
  styles), `web/src/api.ts` (fetch helper).
- The dashboard does not use SSE/real-time updates — it fetches on mount
  and on range change, with a manual refresh button. Real-time updates can
  be added later if needed.
