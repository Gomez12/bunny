import { useCallback, useEffect, useState } from "react";
import {
  type PlanningProject,
  type PlanningReportListItem,
  type PlanningReportRow,
  type ReportDeadlineStatus,
  type ReportOverallStatus,
  type ReportRiskKind,
  type ReportRiskSeverity,
  fetchLatestPlanningReport,
  fetchPlanningReportById,
  generatePlanningReport,
  listPlanningReports,
  planningReportMarkdownUrl,
} from "../../api";
import {
  AlertCircle,
  CheckCircle,
  Download,
  Info,
  Printer,
  RefreshCw,
} from "../../lib/icons";

interface Props {
  planningProject: PlanningProject;
}

const RISK_KIND_LABEL: Record<ReportRiskKind, string> = {
  deadline_overrun: "Deadline overrun",
  cycle: "Dependency cycle",
  tag_unmet: "Tag prerequisite unmet",
  missing_team: "Team missing",
  no_team: "No team",
  no_deadline: "No deadline",
  no_start_date: "Not scheduled",
};

const STATUS_LABEL: Record<ReportOverallStatus, string> = {
  on_track: "On track",
  at_risk: "At risk",
  slipping: "Slipping",
  no_data: "No data",
};

const DEADLINE_LABEL: Record<ReportDeadlineStatus, string> = {
  completed: "Completed",
  on_track: "On track",
  at_risk: "At risk",
  missed: "Missed",
  no_data: "—",
};

const SEVERITY_LABEL: Record<ReportRiskSeverity, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

export default function PlanningReportView({ planningProject }: Props) {
  const [report, setReport] = useState<PlanningReportRow | null>(null);
  const [history, setHistory] = useState<PlanningReportListItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const [latest, list] = await Promise.all([
        fetchLatestPlanningReport(planningProject.id),
        listPlanningReports(planningProject.id),
      ]);
      setReport(latest);
      setHistory(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [planningProject.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleGenerate = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await generatePlanningReport(planningProject.id);
      setReport(next);
      setHistory(await listPlanningReports(planningProject.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handlePickHistory = async (id: number) => {
    if (report?.id === id) return;
    setBusy(true);
    setError(null);
    try {
      setReport(await fetchPlanningReportById(id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const payload = report?.payload;

  return (
    <div className="planning-report">
      <header className="planning-report__header no-print">
        <div>
          <h2>Roadmap status — {planningProject.name}</h2>
          <p className="planning-view__desc">
            Executive-grade snapshot. Each generation is saved to the history
            below; weekly snapshots run automatically.
          </p>
        </div>
        <div className="planning-report__actions">
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => void reload()}
            disabled={busy}
            title="Reload"
          >
            <RefreshCw size={14} /> Reload
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void handleGenerate()}
            disabled={busy}
            title="Generate fresh snapshot"
          >
            <RefreshCw size={14} /> {busy ? "Generating…" : "Generate now"}
          </button>
          {report && (
            <a
              className="btn btn--ghost"
              href={planningReportMarkdownUrl(report.id)}
              download
              title="Download as Markdown"
            >
              <Download size={14} /> Markdown
            </a>
          )}
          {report && (
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => window.print()}
              title="Print or save as PDF"
            >
              <Printer size={14} /> Print
            </button>
          )}
        </div>
      </header>

      {error && <div className="planning-tab__error no-print">{error}</div>}

      {history.length > 0 && (
        <div className="planning-report__history no-print">
          <label>
            History:{" "}
            <select
              value={report?.id ?? ""}
              onChange={(e) =>
                e.target.value === ""
                  ? null
                  : void handlePickHistory(Number(e.target.value))
              }
            >
              {history.map((h) => (
                <option key={h.id} value={h.id}>
                  {formatTime(h.generatedAt)} · {h.trigger} · {h.headline}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {!payload && !busy && (
        <div className="planning-report__empty">
          <Info size={16} /> No report yet. Click{" "}
          <em>Generate now</em> to compute one, or wait for the next
          scheduled snapshot.
        </div>
      )}

      {payload && (
        <article className="planning-report__doc">
          <ReportSummaryCard
            payload={payload}
            generatedAt={payload.generatedAt}
            trigger={report!.trigger}
          />

          {payload.comparison && (
            <ComparisonCard
              comparison={payload.comparison}
              previousReportId={payload.comparison.previousReportId}
            />
          )}

          <ReportSection title="Deadlines" id="deadlines">
            {payload.deadlines.length === 0 ? (
              <p className="planning-report__empty-section">
                No deadlines defined yet.
              </p>
            ) : (
              <table className="planning-report__table">
                <thead>
                  <tr>
                    <th>Deadline</th>
                    <th>Due</th>
                    <th>Status</th>
                    <th>Days until</th>
                    <th>Linked wishes</th>
                    <th>Done</th>
                    <th>At risk</th>
                    <th>Worst overrun</th>
                  </tr>
                </thead>
                <tbody>
                  {payload.deadlines.map((d) => (
                    <tr
                      key={d.id}
                      className={`planning-report__row planning-report__row--${d.status}`}
                    >
                      <td>{d.name}</td>
                      <td className="planning-report__num">{d.dueDate}</td>
                      <td>
                        <DeadlineBadge status={d.status} />
                      </td>
                      <td className="planning-report__num">
                        {d.daysUntilDue >= 0
                          ? `+${d.daysUntilDue}`
                          : d.daysUntilDue}
                      </td>
                      <td className="planning-report__num">{d.wishesLinked}</td>
                      <td className="planning-report__num">{d.wishesDone}</td>
                      <td className="planning-report__num">
                        {d.wishesAtRisk}
                      </td>
                      <td className="planning-report__num">
                        {d.worstOverrunDays > 0
                          ? `${d.worstOverrunDays}d`
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </ReportSection>

          <ReportSection title="Team workload" id="teams">
            {payload.teams.length === 0 ? (
              <p className="planning-report__empty-section">
                No teams defined yet.
              </p>
            ) : (
              <table className="planning-report__table">
                <thead>
                  <tr>
                    <th>Team</th>
                    <th>Members</th>
                    <th>Capacity</th>
                    <th>Active</th>
                    <th>Queued</th>
                    <th>Done</th>
                    <th>Unscheduled</th>
                    <th>Open work</th>
                    <th>Est. working days</th>
                    <th>Earliest free</th>
                  </tr>
                </thead>
                <tbody>
                  {payload.teams.map((t) => (
                    <tr key={t.id}>
                      <td>{t.name}</td>
                      <td className="planning-report__num">{t.members}</td>
                      <td className="planning-report__num">{t.maxParallel}</td>
                      <td className="planning-report__num">{t.activeWishes}</td>
                      <td className="planning-report__num">{t.queuedWishes}</td>
                      <td className="planning-report__num">{t.doneWishes}</td>
                      <td className="planning-report__num">
                        {t.unscheduledWishes}
                      </td>
                      <td className="planning-report__num">
                        {t.totalDurationDaysOpen}d
                      </td>
                      <td className="planning-report__num">
                        {t.estimatedWorkingDaysOfWork}d
                      </td>
                      <td className="planning-report__num">
                        {t.earliestFreeDate ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </ReportSection>

          <ReportSection title="Risks" id="risks">
            {payload.risks.length === 0 ? (
              <p className="planning-report__ok">
                <CheckCircle size={14} /> No risks detected. The current plan
                looks healthy.
              </p>
            ) : (
              <ul className="planning-report__risks">
                {payload.risks.map((r, i) => (
                  <li
                    key={`${r.kind}-${r.wishId ?? "_"}-${i}`}
                    className={`planning-report__risk planning-report__risk--${r.severity}`}
                  >
                    <span
                      className={`planning-report__sev planning-report__sev--${r.severity}`}
                    >
                      {SEVERITY_LABEL[r.severity]}
                    </span>
                    <span className="planning-report__risk-kind">
                      {RISK_KIND_LABEL[r.kind]}
                    </span>
                    <span className="planning-report__risk-title">
                      {r.title}
                    </span>
                    <span className="planning-report__risk-detail">
                      {r.detail}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </ReportSection>

          <ReportSection title="Coverage gaps" id="gaps">
            <GapsBlock gaps={payload.gaps} />
          </ReportSection>

          <ReportSection
            title={`Upcoming (next ${payload.upcoming.windowDays} days)`}
            id="upcoming"
          >
            <UpcomingBlock upcoming={payload.upcoming} />
          </ReportSection>
        </article>
      )}
    </div>
  );
}

function ReportSummaryCard({
  payload,
  generatedAt,
  trigger,
}: {
  payload: PlanningReportRow["payload"];
  generatedAt: number;
  trigger: "manual" | "scheduled";
}) {
  const t = payload.summary.totals;
  return (
    <section
      className={`planning-report__summary planning-report__summary--${payload.summary.overallStatus}`}
    >
      <div className="planning-report__summary-top">
        <div>
          <div className="planning-report__summary-status">
            <StatusDot status={payload.summary.overallStatus} />
            {STATUS_LABEL[payload.summary.overallStatus]}
          </div>
          <h3 className="planning-report__summary-headline">
            {payload.summary.headline}
          </h3>
        </div>
        <div className="planning-report__summary-meta">
          Generated {formatTime(generatedAt)} · {trigger}
        </div>
      </div>
      <p className="planning-report__summary-paragraph">
        {payload.summary.paragraph}
      </p>
      <div className="planning-report__progress" aria-hidden="true">
        <div
          className="planning-report__progress-fill"
          style={{ width: `${t.completionPercent}%` }}
        />
      </div>
      <div className="planning-report__metrics">
        <Metric label="Wishes" value={t.wishes} />
        <Metric label="Done" value={t.done} accent />
        <Metric label="In progress" value={t.inProgress} />
        <Metric label="Planned" value={t.planned} />
        <Metric label="Unscheduled" value={t.unscheduled} />
        <Metric label="Completion" value={`${t.completionPercent}%`} />
        <Metric label="Deadlines" value={t.deadlines} />
        <Metric label="At risk" value={t.deadlinesAtRisk} />
        <Metric label="Missed" value={t.deadlinesMissed} />
        <Metric label="Teams" value={t.teams} />
        <Metric label="Open work" value={`${t.durationDaysPlanned}d`} />
      </div>
    </section>
  );
}

function ComparisonCard({
  comparison,
  previousReportId,
}: {
  comparison: NonNullable<PlanningReportRow["payload"]["comparison"]>;
  previousReportId: number;
}) {
  return (
    <section className="planning-report__comparison">
      <h3>Compared to previous snapshot</h3>
      <p className="planning-report__comparison-meta">
        Previous: {formatTime(comparison.previousGeneratedAt)} (#
        {previousReportId})
      </p>
      <p>{comparison.summary}</p>
      <div className="planning-report__metrics">
        <Metric
          label="Δ wishes done"
          value={signed(comparison.deltaWishesDone)}
        />
        <Metric
          label="Δ unscheduled"
          value={signed(comparison.deltaUnscheduled)}
        />
        <Metric
          label="Δ deadlines at risk"
          value={signed(comparison.deltaWishesAtRisk)}
        />
        <Metric label="New risks" value={comparison.newRisks} />
        <Metric label="Resolved" value={comparison.resolvedRisks} />
      </div>
    </section>
  );
}

function GapsBlock({ gaps }: { gaps: PlanningReportRow["payload"]["gaps"] }) {
  const items: Array<{ key: string; label: string; values: string[] }> = [];
  if (gaps.wishesWithoutTeam.length > 0)
    items.push({
      key: "wishesWithoutTeam",
      label: `${gaps.wishesWithoutTeam.length} wish(es) without a team`,
      values: gaps.wishesWithoutTeam.map((w) => w.title),
    });
  if (gaps.wishesWithoutDeadline.length > 0)
    items.push({
      key: "wishesWithoutDeadline",
      label: `${gaps.wishesWithoutDeadline.length} wish(es) without a deadline`,
      values: gaps.wishesWithoutDeadline.map((w) => w.title),
    });
  if (gaps.unscheduledWishes.length > 0)
    items.push({
      key: "unscheduledWishes",
      label: `${gaps.unscheduledWishes.length} unscheduled wish(es)`,
      values: gaps.unscheduledWishes.map((w) => w.title),
    });
  if (gaps.deadlinesWithoutWishes.length > 0)
    items.push({
      key: "deadlinesWithoutWishes",
      label: `${gaps.deadlinesWithoutWishes.length} deadline(s) without linked wishes`,
      values: gaps.deadlinesWithoutWishes.map(
        (d) => `${d.name} (${d.dueDate})`,
      ),
    });
  if (gaps.unusedTags.length > 0)
    items.push({
      key: "unusedTags",
      label: `${gaps.unusedTags.length} unused tag(s)`,
      values: gaps.unusedTags.map((t) => t.name),
    });
  if (gaps.teamsWithoutMembers.length > 0)
    items.push({
      key: "teamsWithoutMembers",
      label: `${gaps.teamsWithoutMembers.length} team(s) without members (no notification fan-out)`,
      values: gaps.teamsWithoutMembers.map((t) => t.name),
    });
  if (items.length === 0) {
    return (
      <p className="planning-report__ok">
        <CheckCircle size={14} /> No coverage gaps detected.
      </p>
    );
  }
  return (
    <ul className="planning-report__gaps">
      {items.map((it) => (
        <li key={it.key}>
          <strong>{it.label}:</strong> {it.values.join(", ")}
        </li>
      ))}
    </ul>
  );
}

function UpcomingBlock({
  upcoming,
}: {
  upcoming: PlanningReportRow["payload"]["upcoming"];
}) {
  const empty =
    upcoming.startingSoon.length === 0 &&
    upcoming.endingSoon.length === 0 &&
    upcoming.deadlinesSoon.length === 0;
  if (empty) {
    return (
      <p className="planning-report__empty-section">
        Nothing scheduled in the upcoming window.
      </p>
    );
  }
  return (
    <div className="planning-report__upcoming">
      {upcoming.deadlinesSoon.length > 0 && (
        <div>
          <h4>Deadlines</h4>
          <ul>
            {upcoming.deadlinesSoon.map((d) => (
              <li key={d.id}>
                <span className="planning-report__num">{d.dueDate}</span> —{" "}
                {d.name}
              </li>
            ))}
          </ul>
        </div>
      )}
      {upcoming.startingSoon.length > 0 && (
        <div>
          <h4>Starting</h4>
          <ul>
            {upcoming.startingSoon.map((it) => (
              <li key={`s-${it.wishId}`}>
                <span className="planning-report__num">{it.date}</span> —{" "}
                {it.title}
                {it.team ? ` (${it.team})` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
      {upcoming.endingSoon.length > 0 && (
        <div>
          <h4>Finishing</h4>
          <ul>
            {upcoming.endingSoon.map((it) => (
              <li key={`e-${it.wishId}`}>
                <span className="planning-report__num">{it.date}</span> —{" "}
                {it.title}
                {it.team ? ` (${it.team})` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ReportSection({
  title,
  id,
  children,
}: {
  title: string;
  id?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="planning-report__section" id={id}>
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function Metric({
  label,
  value,
  accent,
}: {
  label: string;
  value: number | string;
  accent?: boolean;
}) {
  return (
    <div className={`planning-report__metric ${accent ? "planning-report__metric--accent" : ""}`}>
      <div className="planning-report__metric-value">{value}</div>
      <div className="planning-report__metric-label">{label}</div>
    </div>
  );
}

function DeadlineBadge({ status }: { status: ReportDeadlineStatus }) {
  return (
    <span className={`planning-report__badge planning-report__badge--${status}`}>
      {DEADLINE_LABEL[status]}
    </span>
  );
}

function StatusDot({ status }: { status: ReportOverallStatus }) {
  return (
    <span
      className={`planning-report__status-dot planning-report__status-dot--${status}`}
      aria-hidden="true"
    >
      {status === "slipping" || status === "at_risk" ? (
        <AlertCircle size={16} />
      ) : status === "on_track" ? (
        <CheckCircle size={16} />
      ) : (
        <Info size={16} />
      )}
    </span>
  );
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}
