import { useCallback, useEffect, useState } from "react";
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { fetchDashboard, type AuthUser, type DashboardData, type DashboardRange } from "../api";

interface Props {
  currentUser: AuthUser;
}

const RANGES: { key: DashboardRange; label: string }[] = [
  { key: "24h", label: "24h" },
  { key: "7d", label: "7d" },
  { key: "30d", label: "30d" },
  { key: "90d", label: "90d" },
  { key: "all", label: "All" },
];

const ACCENT_PALETTE = [
  "#7c5cff",
  "#a78bfa",
  "#6366f1",
  "#818cf8",
  "#4f46e5",
  "#c084fc",
  "#8b5cf6",
  "#5b47bf",
];

const GRID_STROKE = "#23272f";
const AXIS_FILL = "#9aa0aa";

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function formatMs(ms: number | null): string {
  if (ms === null || ms === undefined) return "—";
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

function formatTs(ts: number, range: DashboardRange): string {
  const d = new Date(ts);
  if (range === "24h") return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (range === "7d") return d.toLocaleDateString([], { weekday: "short", hour: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function ChartTooltip({ active, payload, label, range }: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: number;
  range: DashboardRange;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="dash-tooltip">
      <div className="dash-tooltip-label">{typeof label === "number" ? formatTs(label, range) : label}</div>
      {payload.map((p, i) => (
        <div key={i} className="dash-tooltip-row">
          <span className="dash-tooltip-dot" style={{ background: p.color }} />
          <span className="dash-tooltip-name">{p.name}</span>
          <span className="dash-tooltip-val">{formatNumber(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

function KpiCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="dash-kpi">
      <div className="dash-kpi-label">{label}</div>
      <div className="dash-kpi-value">{value}</div>
      {sub && <div className="dash-kpi-sub">{sub}</div>}
    </div>
  );
}

export default function DashboardTab(_props: Props) {
  const [range, setRange] = useState<DashboardRange>("7d");
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (r: DashboardRange) => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchDashboard(r));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load dashboard");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(range);
  }, [range, load]);

  const handleRange = (r: DashboardRange) => setRange(r);
  const handleRefresh = () => void load(range);

  if (error && !data) {
    return (
      <div className="dash-container">
        <div className="dash-error">{error}</div>
      </div>
    );
  }

  return (
    <div className="dash-container">
      <div className="dash-header">
        <div className="dash-range-bar">
          {RANGES.map((r) => (
            <button
              key={r.key}
              className={`dash-range-pill${range === r.key ? " dash-range-pill--active" : ""}`}
              onClick={() => handleRange(r.key)}
            >
              {r.label}
            </button>
          ))}
        </div>
        <button className="dash-refresh" onClick={handleRefresh} disabled={loading} title="Refresh">
          {loading ? "..." : "\u21BB"}
        </button>
      </div>

      {data && (
        <>
          {/* KPI row */}
          <div className="dash-kpi-row">
            <KpiCard label="Messages" value={formatNumber(data.kpi.totalMessages)} />
            <KpiCard label="Sessions" value={formatNumber(data.kpi.totalSessions)} />
            <KpiCard
              label="Tokens"
              value={formatNumber(data.kpi.totalPromptTokens + data.kpi.totalCompletionTokens)}
              sub={`${formatNumber(data.kpi.totalPromptTokens)} in / ${formatNumber(data.kpi.totalCompletionTokens)} out`}
            />
            <KpiCard label="Avg Response" value={formatMs(data.kpi.avgResponseMs)} />
          </div>

          {/* Activity over time — full width */}
          <div className="dash-chart-full">
            <h3 className="dash-chart-title">Activity</h3>
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={data.activityOverTime}>
                <defs>
                  <linearGradient id="activityGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#7c5cff" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="#7c5cff" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
                <XAxis
                  dataKey="ts"
                  tickFormatter={(v: number) => formatTs(v, range)}
                  tick={{ fill: AXIS_FILL, fontSize: 11 }}
                  stroke={GRID_STROKE}
                />
                <YAxis tick={{ fill: AXIS_FILL, fontSize: 11 }} stroke={GRID_STROKE} />
                <Tooltip content={<ChartTooltip range={range} />} />
                <Area
                  type="monotone"
                  dataKey="count"
                  name="Messages"
                  stroke="#7c5cff"
                  strokeWidth={2}
                  fill="url(#activityGrad)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          {/* Tokens + Response time — 2 col */}
          <div className="dash-chart-row">
            <div className="dash-chart-half">
              <h3 className="dash-chart-title">Token Usage</h3>
              <ResponsiveContainer width="100%" height={200}>
                <AreaChart data={data.tokensOverTime}>
                  <defs>
                    <linearGradient id="promptGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#7c5cff" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="#7c5cff" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="completionGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#a78bfa" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="#a78bfa" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
                  <XAxis
                    dataKey="ts"
                    tickFormatter={(v: number) => formatTs(v, range)}
                    tick={{ fill: AXIS_FILL, fontSize: 11 }}
                    stroke={GRID_STROKE}
                  />
                  <YAxis tick={{ fill: AXIS_FILL, fontSize: 11 }} stroke={GRID_STROKE} />
                  <Tooltip content={<ChartTooltip range={range} />} />
                  <Area type="monotone" dataKey="prompt" name="Prompt" stroke="#7c5cff" strokeWidth={2} fill="url(#promptGrad)" />
                  <Area type="monotone" dataKey="completion" name="Completion" stroke="#a78bfa" strokeWidth={2} fill="url(#completionGrad)" />
                  <Legend iconType="circle" wrapperStyle={{ fontSize: 11, color: AXIS_FILL }} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <div className="dash-chart-half">
              <h3 className="dash-chart-title">Response Time</h3>
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={data.responseTimeOverTime}>
                  <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
                  <XAxis
                    dataKey="ts"
                    tickFormatter={(v: number) => formatTs(v, range)}
                    tick={{ fill: AXIS_FILL, fontSize: 11 }}
                    stroke={GRID_STROKE}
                  />
                  <YAxis
                    tickFormatter={(v: number) => formatMs(v)}
                    tick={{ fill: AXIS_FILL, fontSize: 11 }}
                    stroke={GRID_STROKE}
                  />
                  <Tooltip
                    content={({ active, payload, label }) => {
                      if (!active || !payload?.length) return null;
                      return (
                        <div className="dash-tooltip">
                          <div className="dash-tooltip-label">{typeof label === "number" ? formatTs(label, range) : label}</div>
                          <div className="dash-tooltip-row">
                            <span className="dash-tooltip-dot" style={{ background: "#818cf8" }} />
                            <span className="dash-tooltip-name">Avg</span>
                            <span className="dash-tooltip-val">{formatMs(payload[0]?.value as number)}</span>
                          </div>
                        </div>
                      );
                    }}
                  />
                  <Line
                    type="monotone"
                    dataKey="avgMs"
                    name="Avg ms"
                    stroke="#818cf8"
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Tool usage + Agent activity — 2 col */}
          <div className="dash-chart-row">
            <div className="dash-chart-half">
              <h3 className="dash-chart-title">Top Tools</h3>
              {data.toolUsage.length === 0 ? (
                <div className="dash-empty">No tool calls in this period</div>
              ) : (
                <ResponsiveContainer width="100%" height={Math.max(200, data.toolUsage.length * 28)}>
                  <BarChart data={data.toolUsage} layout="vertical" margin={{ left: 10, right: 20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} horizontal={false} />
                    <XAxis type="number" tick={{ fill: AXIS_FILL, fontSize: 11 }} stroke={GRID_STROKE} />
                    <YAxis
                      dataKey="name"
                      type="category"
                      width={120}
                      tick={{ fill: AXIS_FILL, fontSize: 11 }}
                      stroke={GRID_STROKE}
                    />
                    <Tooltip
                      content={({ active, payload }) => {
                        if (!active || !payload?.length) return null;
                        const d = payload[0]?.payload as { name: string; count: number };
                        return (
                          <div className="dash-tooltip">
                            <div className="dash-tooltip-label">{d.name}</div>
                            <div className="dash-tooltip-row">
                              <span className="dash-tooltip-val">{d.count} calls</span>
                            </div>
                          </div>
                        );
                      }}
                    />
                    <Bar dataKey="count" fill="#7c5cff" radius={[0, 4, 4, 0]} barSize={16} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
            <div className="dash-chart-half">
              <h3 className="dash-chart-title">Agent Activity</h3>
              {data.agentActivity.length === 0 ? (
                <div className="dash-empty">No agent activity in this period</div>
              ) : (
                <ResponsiveContainer width="100%" height={250}>
                  <PieChart>
                    <Pie
                      data={data.agentActivity}
                      dataKey="count"
                      nameKey="agent"
                      cx="50%"
                      cy="50%"
                      innerRadius={55}
                      outerRadius={90}
                      paddingAngle={2}
                      strokeWidth={0}
                    >
                      {data.agentActivity.map((_, i) => (
                        <Cell key={i} fill={ACCENT_PALETTE[i % ACCENT_PALETTE.length]} />
                      ))}
                    </Pie>
                    <Tooltip
                      content={({ active, payload }) => {
                        if (!active || !payload?.length) return null;
                        const d = payload[0]?.payload as { agent: string; count: number };
                        return (
                          <div className="dash-tooltip">
                            <div className="dash-tooltip-label">@{d.agent}</div>
                            <div className="dash-tooltip-row">
                              <span className="dash-tooltip-val">{d.count} messages</span>
                            </div>
                          </div>
                        );
                      }}
                    />
                    <Legend
                      iconType="circle"
                      wrapperStyle={{ fontSize: 11, color: AXIS_FILL }}
                      formatter={(value: string) => `@${value}`}
                    />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          {/* Project activity + Board overview — 2 col */}
          <div className="dash-chart-row">
            <div className="dash-chart-half">
              <h3 className="dash-chart-title">Project Activity</h3>
              {data.projectActivity.length === 0 ? (
                <div className="dash-empty">No project activity in this period</div>
              ) : (
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={data.projectActivity} margin={{ bottom: 40 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
                    <XAxis
                      dataKey="project"
                      tick={{ fill: AXIS_FILL, fontSize: 11 }}
                      stroke={GRID_STROKE}
                      angle={-35}
                      textAnchor="end"
                    />
                    <YAxis tick={{ fill: AXIS_FILL, fontSize: 11 }} stroke={GRID_STROKE} />
                    <Tooltip
                      content={({ active, payload }) => {
                        if (!active || !payload?.length) return null;
                        const d = payload[0]?.payload as { project: string; count: number };
                        return (
                          <div className="dash-tooltip">
                            <div className="dash-tooltip-label">{d.project}</div>
                            <div className="dash-tooltip-row">
                              <span className="dash-tooltip-val">{d.count} messages</span>
                            </div>
                          </div>
                        );
                      }}
                    />
                    <Bar dataKey="count" radius={[4, 4, 0, 0]} barSize={24}>
                      {data.projectActivity.map((_, i) => (
                        <Cell key={i} fill={ACCENT_PALETTE[i % ACCENT_PALETTE.length]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
            <div className="dash-chart-half">
              <h3 className="dash-chart-title">Board Overview</h3>
              {data.boardOverview.length === 0 ? (
                <div className="dash-empty">No board lanes configured</div>
              ) : (
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={data.boardOverview} layout="vertical" margin={{ left: 10, right: 20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} horizontal={false} />
                    <XAxis type="number" tick={{ fill: AXIS_FILL, fontSize: 11 }} stroke={GRID_STROKE} />
                    <YAxis
                      dataKey="lane"
                      type="category"
                      width={100}
                      tick={{ fill: AXIS_FILL, fontSize: 11 }}
                      stroke={GRID_STROKE}
                    />
                    <Tooltip
                      content={({ active, payload }) => {
                        if (!active || !payload?.length) return null;
                        const d = payload[0]?.payload as { lane: string; count: number };
                        return (
                          <div className="dash-tooltip">
                            <div className="dash-tooltip-label">{d.lane}</div>
                            <div className="dash-tooltip-row">
                              <span className="dash-tooltip-val">{d.count} cards</span>
                            </div>
                          </div>
                        );
                      }}
                    />
                    <Bar dataKey="count" fill="#6366f1" radius={[0, 4, 4, 0]} barSize={18} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          {/* Footer row: Error rate, Scheduler, Recent Activity */}
          <div className="dash-footer-row">
            <div className="dash-card dash-card--compact">
              <h3 className="dash-chart-title">Error Rate</h3>
              <div className="dash-error-rate">
                <span className={`dash-error-pct ${data.errorRate.errors === 0 ? "dash-error-pct--ok" : "dash-error-pct--warn"}`}>
                  {data.errorRate.total === 0 ? "0%" : `${((data.errorRate.errors / data.errorRate.total) * 100).toFixed(1)}%`}
                </span>
                <span className="dash-error-detail">
                  {formatNumber(data.errorRate.errors)} / {formatNumber(data.errorRate.total)} events
                </span>
              </div>
            </div>

            <div className="dash-card dash-card--compact">
              <h3 className="dash-chart-title">Scheduler</h3>
              <div className="dash-scheduler">
                <div className="dash-scheduler-row">
                  <span className="dash-scheduler-label">Tasks</span>
                  <span>{data.scheduler.enabled} / {data.scheduler.total} enabled</span>
                </div>
                {data.scheduler.errored > 0 && (
                  <div className="dash-scheduler-row dash-scheduler-row--err">
                    <span className="dash-scheduler-label">Errors</span>
                    <span>{data.scheduler.errored}</span>
                  </div>
                )}
                <div className="dash-scheduler-row">
                  <span className="dash-scheduler-label">Next run</span>
                  <span>{data.scheduler.nextDue ? timeAgo(data.scheduler.nextDue) : "—"}</span>
                </div>
              </div>
            </div>

            <div className="dash-card dash-card--feed">
              <h3 className="dash-chart-title">Recent Activity</h3>
              <div className="dash-feed">
                {data.recentActivity.length === 0 ? (
                  <div className="dash-empty">No recent events</div>
                ) : (
                  data.recentActivity.map((ev) => (
                    <div key={ev.id} className={`dash-feed-item${ev.error ? " dash-feed-item--err" : ""}`}>
                      <span className="dash-feed-topic">{ev.topic}</span>
                      <span className="dash-feed-kind">{ev.kind}</span>
                      {ev.durationMs != null && (
                        <span className="dash-feed-dur">{formatMs(ev.durationMs)}</span>
                      )}
                      <span className="dash-feed-time">{timeAgo(ev.ts)}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* Card run status (only show if there are runs) */}
          {data.cardRunStatus.length > 0 && (
            <div className="dash-chart-full">
              <h3 className="dash-chart-title">Card Run Status</h3>
              <div className="dash-run-pills">
                {data.cardRunStatus.map((s) => (
                  <span key={s.status} className={`dash-run-pill dash-run-pill--${s.status}`}>
                    {s.status}: {s.count}
                  </span>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
