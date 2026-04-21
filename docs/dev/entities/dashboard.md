# Dashboard

## What it is

A single-page overview of platform health: KPIs, time-series charts, tool/agent/project breakdowns, error rates, scheduler health, and a recent-activity feed. Admin sees global stats; non-admin sees their own data only.

Powered by Recharts and a single `GET /api/dashboard?range=24h|7d|30d|90d|all` endpoint backed by `src/memory/stats.ts`. No separate dashboard tables — the whole surface reads from `events` + `messages` + the entity tables.

## HTTP API

- `GET /api/dashboard?range=<24h|7d|30d|90d|all>` — returns the full snapshot in one payload.

Payload shape (high-level):

```ts
{
  kpis: { sessions, messages, tokens, errors, … },
  timeseries: {
    messages: [{ts, count}, …],
    tokens:   [{ts, in, out}, …],
    errors:   [{ts, count}, …],
  },
  breakdowns: {
    byTool:    [{name, count}, …],
    byAgent:   [{name, count}, …],
    byProject: [{name, count}, …],
  },
  scheduler: {
    tasks: [{id, handler, lastStatus, lastError, nextRunAt}, …],
  },
  recentActivity: [{ts, topic, kind, sessionId, userId}, …],
}
```

## Code paths

- `src/memory/stats.ts` — every dashboard query. One call per section; the route composes them.
- `src/server/dashboard_routes.ts`.
- `web/src/tabs/DashboardTab.tsx` — Recharts wiring.

Frontend dep: `recharts`.

## UI

- `web/src/tabs/DashboardTab.tsx`.
- `.app-shell__main--dense` class — the Dashboard uses this to skip the rabbit watermark (information density).

## Extension hooks

- **Translation:** no.
- **Trash:** no.
- **Notifications:** no.
- **Scheduler:** no.
- **Tools:** no.

## Scope

- Admins see global stats — `events` is queried without a `user_id` filter.
- Non-admins see only their own data — every query in `stats.ts` for non-admin routes adds `AND user_id = ?`.

## Key invariants

- **Single endpoint, single call.** The dashboard does not fan out over many API calls — one roundtrip on tab open, re-fetched on range change.
- **Derived from `events` + `messages`.** No separate `stats` table. Materialisation is ad-hoc via `src/memory/stats.ts`.
- **Range-bucketed.** Timeseries resolution adapts to the range (minute for 24h, hour for 7d, day for 30d+).
- **Admin vs non-admin differ only in scope.** Same endpoint, different filter.

## Gotchas

- Heavy queries on a large `events` table can be slow. Indexes: `idx_events_topic(topic, ts)` and `idx_events_session(session_id, ts)`. Adding a new topic that's queried by the dashboard may need a new index.
- `all` range on a long-lived DB is the slow case. Budget ~1s for the query; the UI shows a skeleton while it loads.
- Activity feed shows the last 100 events; there's no pagination.

## Related

- [ADR 0014 — Dashboard](../../adr/0014-dashboard.md)
- [`../concepts/queue-and-logging.md`](../concepts/queue-and-logging.md) — the upstream data source.
- Logs tab (Settings → Logs) — admin-only drill-down into individual events.
