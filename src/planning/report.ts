/**
 * Pure executive-grade report builder for the Planning module.
 *
 * Inputs are read from the DB; outputs are a structured payload + a
 * markdown rendition for export. No LLM calls — synthesis is deterministic.
 *
 * Sections:
 *   1. Summary (headline + counts + overall status)
 *   2. Deadlines (per-deadline status + linked-wish stats)
 *   3. Teams (per-team workload + utilisation)
 *   4. Risks (severity-sorted)
 *   5. Coverage gaps (missing teams / deadlines / estimates / etc.)
 *   6. Upcoming (next 14 working days)
 *   7. Comparison vs. previous snapshot (deltas)
 *
 * The same `buildReportPayload` powers the on-demand "Generate now" button
 * and the periodic `planning.report_snapshot` handler.
 */

import type { Database } from "bun:sqlite";
import { getPlanningProject } from "../memory/planning_projects.ts";
import { listWishes } from "../memory/planning_wishes.ts";
import { listTeams } from "../memory/planning_teams.ts";
import { listDeadlines } from "../memory/planning_deadlines.ts";
import { listTags } from "../memory/planning_tags.ts";
import { computeSchedule, formatDate, parseDate } from "./scheduler.ts";

// ── Types ──────────────────────────────────────────────────────────────────

export type ReportOverallStatus =
  | "on_track"
  | "at_risk"
  | "slipping"
  | "no_data";

export type ReportDeadlineStatus =
  | "completed"
  | "on_track"
  | "at_risk"
  | "missed"
  | "no_data";

export type ReportRiskKind =
  | "deadline_overrun"
  | "cycle"
  | "tag_unmet"
  | "missing_team"
  | "no_team"
  | "no_deadline"
  | "no_start_date";

export type ReportRiskSeverity = "high" | "medium" | "low";

export interface ReportSummary {
  overallStatus: ReportOverallStatus;
  headline: string;
  paragraph: string;
  totals: {
    wishes: number;
    done: number;
    inProgress: number;
    planned: number;
    unscheduled: number;
    completionPercent: number;
    deadlines: number;
    deadlinesAtRisk: number;
    deadlinesMissed: number;
    teams: number;
    durationDaysPlanned: number;
  };
}

export interface ReportDeadline {
  id: number;
  name: string;
  dueDate: string;
  status: ReportDeadlineStatus;
  daysUntilDue: number;
  wishesLinked: number;
  wishesDone: number;
  wishesAtRisk: number;
  worstOverrunDays: number;
}

export interface ReportTeam {
  id: number;
  name: string;
  maxParallel: number;
  members: number;
  activeWishes: number;
  queuedWishes: number;
  doneWishes: number;
  unscheduledWishes: number;
  totalDurationDaysOpen: number;
  estimatedWorkingDaysOfWork: number;
  earliestFreeDate: string | null;
}

export interface ReportRisk {
  severity: ReportRiskSeverity;
  kind: ReportRiskKind;
  wishId?: number;
  title: string;
  detail: string;
}

export interface ReportGapWishRef {
  id: number;
  title: string;
  durationDays: number;
  teamId: number | null;
}

export interface ReportGaps {
  wishesWithoutTeam: ReportGapWishRef[];
  wishesWithoutDeadline: ReportGapWishRef[];
  unscheduledWishes: ReportGapWishRef[];
  deadlinesWithoutWishes: Array<{ id: number; name: string; dueDate: string }>;
  unusedTags: Array<{ id: number; name: string }>;
  teamsWithoutMembers: Array<{ id: number; name: string }>;
}

export interface ReportUpcomingItem {
  wishId: number;
  title: string;
  team: string | null;
  date: string;
}

export interface ReportUpcoming {
  windowDays: number;
  startingSoon: ReportUpcomingItem[];
  endingSoon: ReportUpcomingItem[];
  deadlinesSoon: Array<{ id: number; name: string; dueDate: string }>;
}

export interface ReportComparison {
  previousReportId: number;
  previousGeneratedAt: number;
  deltaWishesDone: number;
  deltaWishesAtRisk: number;
  deltaUnscheduled: number;
  newRisks: number;
  resolvedRisks: number;
  summary: string;
}

export interface ReportPayload {
  generatedAt: number;
  planningProject: {
    id: number;
    name: string;
    description: string;
    startDate: string | null;
  };
  summary: ReportSummary;
  deadlines: ReportDeadline[];
  teams: ReportTeam[];
  risks: ReportRisk[];
  gaps: ReportGaps;
  upcoming: ReportUpcoming;
  comparison?: ReportComparison;
}

// ── Build helpers ──────────────────────────────────────────────────────────

function todayIso(now: number): string {
  return formatDate(new Date(now));
}

function diffDays(fromIso: string, toIso: string): number {
  const a = parseDate(fromIso).getTime();
  const b = parseDate(toIso).getTime();
  return Math.round((b - a) / 86_400_000);
}

function severityForKind(kind: ReportRiskKind): ReportRiskSeverity {
  switch (kind) {
    case "deadline_overrun":
    case "cycle":
    case "missing_team":
      return "high";
    case "tag_unmet":
    case "no_start_date":
      return "medium";
    case "no_team":
    case "no_deadline":
      return "low";
  }
}

function severityRank(s: ReportRiskSeverity): number {
  return s === "high" ? 0 : s === "medium" ? 1 : 2;
}

// ── Main builder ───────────────────────────────────────────────────────────

export interface BuildReportOpts {
  /** Inject "now" for testability. Defaults to Date.now(). */
  now?: number;
  /** Window for the "upcoming" section in calendar days. Default 14. */
  upcomingWindowDays?: number;
  /** Previous snapshot's payload, when available. Drives the comparison
   *  section. Pass null/undefined to skip. */
  previous?: ReportPayload | null;
  /** ID of the previous snapshot, exposed in the comparison block. */
  previousReportId?: number;
  /** Generation timestamp of the previous snapshot. */
  previousGeneratedAt?: number;
}

export function buildReportPayload(
  db: Database,
  planningProjectId: number,
  opts: BuildReportOpts = {},
): ReportPayload | null {
  const pp = getPlanningProject(db, planningProjectId);
  if (!pp) return null;
  const now = opts.now ?? Date.now();
  const today = todayIso(now);
  const windowDays = opts.upcomingWindowDays ?? 14;

  const wishes = listWishes(db, planningProjectId);
  const teams = listTeams(db, planningProjectId);
  const deadlines = listDeadlines(db, planningProjectId);
  const tags = listTags(db, planningProjectId);

  // Empty plans short-circuit — no scheduler run, no per-team rollups.
  if (wishes.length === 0) {
    return {
      generatedAt: now,
      planningProject: {
        id: pp.id,
        name: pp.name,
        description: pp.description,
        startDate: pp.startDate,
      },
      summary: {
        overallStatus: "no_data",
        headline: "No wishes yet — roadmap empty.",
        paragraph:
          "No wishes have been added to this planning project yet. Add deadlines, teams, and wishes to populate the roadmap.",
        totals: {
          wishes: 0,
          done: 0,
          inProgress: 0,
          planned: 0,
          unscheduled: 0,
          completionPercent: 0,
          deadlines: deadlines.length,
          deadlinesAtRisk: 0,
          deadlinesMissed: 0,
          teams: teams.length,
          durationDaysPlanned: 0,
        },
      },
      deadlines: [],
      teams: [],
      risks: [],
      gaps: {
        wishesWithoutTeam: [],
        wishesWithoutDeadline: [],
        unscheduledWishes: [],
        deadlinesWithoutWishes: deadlines.map((d) => ({
          id: d.id,
          name: d.name,
          dueDate: d.dueDate,
        })),
        unusedTags: tags.map((t) => ({ id: t.id, name: t.name })),
        teamsWithoutMembers: teams
          .filter((t) => t.members.length === 0)
          .map((t) => ({ id: t.id, name: t.name })),
      },
      upcoming: {
        windowDays: opts.upcomingWindowDays ?? 14,
        startingSoon: [],
        endingSoon: [],
        deadlinesSoon: deadlines
          .filter(
            (d) =>
              d.dueDate >= today &&
              d.dueDate <=
                formatDate(
                  new Date(
                    now + (opts.upcomingWindowDays ?? 14) * 86_400_000,
                  ),
                ),
          )
          .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
          .map((d) => ({ id: d.id, name: d.name, dueDate: d.dueDate })),
      },
    };
  }

  const teamById = new Map(teams.map((t) => [t.id, t]));
  const deadlineById = new Map(deadlines.map((d) => [d.id, d]));

  // ── Per-wish status buckets ────────────────────────────────────────────
  const done = wishes.filter((w) => w.status === "done");
  const inProgress = wishes.filter((w) => w.status === "in_progress");
  const planned = wishes.filter((w) => w.status === "planned");
  const unscheduled = wishes.filter(
    (w) => w.status !== "done" && !w.plannedStartDate,
  );

  const completionPercent =
    wishes.length === 0
      ? 0
      : Math.round((done.length / wishes.length) * 100);

  // ── Schedule re-run with manual locks → harvest scheduler bottlenecks ──
  // We honour each wish's planned_start_date as a manual lock so the
  // bottleneck list reflects the user's current plan, not a hypothetical
  // schedule.
  const scheduleStart = pp.startDate ?? today;
  const scheduleOut = computeSchedule({
    startDate: scheduleStart,
    wishes: wishes.map((w) => ({
      id: w.id,
      durationDays: w.durationDays,
      teamId: w.teamId,
      deadlineId: w.deadlineId,
      dependsOnWishes: w.dependsOnWishes,
      dependsOnTags: w.dependsOnTags,
      tagIds: w.tagIds,
      manualStartDate: w.plannedStartDate,
    })),
    teams: teams.map((t) => ({ id: t.id, maxParallel: t.maxParallel })),
    deadlines: deadlines.map((d) => ({ id: d.id, dueDate: d.dueDate })),
    tags: tags.map((t) => ({ id: t.id, name: t.name })),
  });

  // ── Risks ──────────────────────────────────────────────────────────────
  const risks: ReportRisk[] = [];
  const wishById = new Map(wishes.map((w) => [w.id, w]));

  for (const b of scheduleOut.bottlenecks) {
    const wish = wishById.get(b.wishId);
    risks.push({
      severity: severityForKind(b.kind),
      kind: b.kind,
      wishId: b.wishId,
      title: wish?.title ?? `Wish #${b.wishId}`,
      detail: b.message,
    });
  }
  for (const w of wishes) {
    if (w.status === "done") continue;
    if (w.teamId === null) {
      risks.push({
        severity: severityForKind("no_team"),
        kind: "no_team",
        wishId: w.id,
        title: w.title,
        detail: "No team assigned — owner unclear.",
      });
    }
    if (w.deadlineId === null) {
      risks.push({
        severity: severityForKind("no_deadline"),
        kind: "no_deadline",
        wishId: w.id,
        title: w.title,
        detail: "No deadline linked — finish date is open-ended.",
      });
    }
    if (!w.plannedStartDate) {
      risks.push({
        severity: severityForKind("no_start_date"),
        kind: "no_start_date",
        wishId: w.id,
        title: w.title,
        detail: "No planned start date — wish is not yet on the timeline.",
      });
    }
  }
  risks.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));

  // ── Deadlines ──────────────────────────────────────────────────────────
  const deadlineReports: ReportDeadline[] = deadlines.map((d) => {
    const linked = wishes.filter((w) => w.deadlineId === d.id);
    const linkedDone = linked.filter((w) => w.status === "done").length;
    const overruns = linked.filter(
      (w) => w.plannedEndDate && w.plannedEndDate > d.dueDate,
    );
    const wishesAtRisk =
      overruns.length +
      linked.filter((w) => w.status !== "done" && !w.plannedEndDate).length;
    const worstOverrunDays = overruns.reduce((max, w) => {
      const o = diffDays(d.dueDate, w.plannedEndDate!);
      return o > max ? o : max;
    }, 0);
    const daysUntilDue = diffDays(today, d.dueDate);
    let status: ReportDeadlineStatus;
    if (linked.length === 0) status = "no_data";
    else if (linkedDone === linked.length) status = "completed";
    else if (daysUntilDue < 0) status = "missed";
    else if (overruns.length > 0 || wishesAtRisk > 0) status = "at_risk";
    else status = "on_track";
    return {
      id: d.id,
      name: d.name,
      dueDate: d.dueDate,
      status,
      daysUntilDue,
      wishesLinked: linked.length,
      wishesDone: linkedDone,
      wishesAtRisk,
      worstOverrunDays,
    };
  });
  deadlineReports.sort((a, b) =>
    a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0,
  );

  // ── Teams ──────────────────────────────────────────────────────────────
  const teamReports: ReportTeam[] = teams.map((t) => {
    const teamWishes = wishes.filter((w) => w.teamId === t.id);
    const active = teamWishes.filter((w) => w.status === "in_progress").length;
    const queued = teamWishes.filter((w) => w.status === "planned").length;
    const completed = teamWishes.filter((w) => w.status === "done").length;
    const unsched = teamWishes.filter(
      (w) => w.status !== "done" && !w.plannedStartDate,
    ).length;
    const totalOpen = teamWishes
      .filter((w) => w.status !== "done")
      .reduce((sum, w) => sum + w.durationDays, 0);
    const estimatedDays =
      t.maxParallel > 0 ? Math.ceil(totalOpen / t.maxParallel) : totalOpen;
    const ends = teamWishes
      .filter((w) => w.status !== "done" && w.plannedEndDate)
      .map((w) => w.plannedEndDate!)
      .sort();
    const earliestFree = ends.length > 0 ? ends[ends.length - 1]! : null;
    return {
      id: t.id,
      name: t.name,
      maxParallel: t.maxParallel,
      members: t.members.length,
      activeWishes: active,
      queuedWishes: queued,
      doneWishes: completed,
      unscheduledWishes: unsched,
      totalDurationDaysOpen: totalOpen,
      estimatedWorkingDaysOfWork: estimatedDays,
      earliestFreeDate: earliestFree,
    };
  });
  teamReports.sort((a, b) => a.name.localeCompare(b.name));

  // ── Coverage gaps ──────────────────────────────────────────────────────
  const usedTagIds = new Set<number>();
  for (const w of wishes) for (const tid of w.tagIds) usedTagIds.add(tid);
  const teamIdsWithMembers = new Set(
    teams.filter((t) => t.members.length > 0).map((t) => t.id),
  );

  const gaps: ReportGaps = {
    wishesWithoutTeam: wishes
      .filter((w) => w.status !== "done" && w.teamId === null)
      .map((w) => ({
        id: w.id,
        title: w.title,
        durationDays: w.durationDays,
        teamId: w.teamId,
      })),
    wishesWithoutDeadline: wishes
      .filter((w) => w.status !== "done" && w.deadlineId === null)
      .map((w) => ({
        id: w.id,
        title: w.title,
        durationDays: w.durationDays,
        teamId: w.teamId,
      })),
    unscheduledWishes: wishes
      .filter((w) => w.status !== "done" && !w.plannedStartDate)
      .map((w) => ({
        id: w.id,
        title: w.title,
        durationDays: w.durationDays,
        teamId: w.teamId,
      })),
    deadlinesWithoutWishes: deadlines
      .filter((d) => !wishes.some((w) => w.deadlineId === d.id))
      .map((d) => ({ id: d.id, name: d.name, dueDate: d.dueDate })),
    unusedTags: tags
      .filter((t) => !usedTagIds.has(t.id))
      .map((t) => ({ id: t.id, name: t.name })),
    teamsWithoutMembers: teams
      .filter((t) => !teamIdsWithMembers.has(t.id))
      .map((t) => ({ id: t.id, name: t.name })),
  };

  // ── Upcoming (next windowDays calendar days) ───────────────────────────
  const horizonIso = formatDate(new Date(now + windowDays * 86_400_000));
  const inWindow = (d: string) => d >= today && d <= horizonIso;

  const upcoming: ReportUpcoming = {
    windowDays,
    startingSoon: wishes
      .filter(
        (w) =>
          w.status !== "done" &&
          w.plannedStartDate &&
          inWindow(w.plannedStartDate),
      )
      .map((w) => ({
        wishId: w.id,
        title: w.title,
        team: w.teamId !== null ? teamById.get(w.teamId)?.name ?? null : null,
        date: w.plannedStartDate!,
      }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    endingSoon: wishes
      .filter(
        (w) =>
          w.status !== "done" &&
          w.plannedEndDate &&
          inWindow(w.plannedEndDate),
      )
      .map((w) => ({
        wishId: w.id,
        title: w.title,
        team: w.teamId !== null ? teamById.get(w.teamId)?.name ?? null : null,
        date: w.plannedEndDate!,
      }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    deadlinesSoon: deadlines
      .filter((d) => inWindow(d.dueDate))
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
      .map((d) => ({ id: d.id, name: d.name, dueDate: d.dueDate })),
  };

  // ── Summary headline ───────────────────────────────────────────────────
  const deadlinesAtRisk = deadlineReports.filter(
    (d) => d.status === "at_risk",
  ).length;
  const deadlinesMissed = deadlineReports.filter(
    (d) => d.status === "missed",
  ).length;
  const highRisks = risks.filter((r) => r.severity === "high").length;
  const mediumRisks = risks.filter((r) => r.severity === "medium").length;

  let overallStatus: ReportOverallStatus;
  if (wishes.length === 0) overallStatus = "no_data";
  else if (deadlinesMissed > 0 || highRisks > 0) overallStatus = "slipping";
  else if (deadlinesAtRisk > 0 || mediumRisks > 0)
    overallStatus = "at_risk";
  else overallStatus = "on_track";

  let headline: string;
  if (overallStatus === "no_data") {
    headline = "No wishes yet — roadmap empty.";
  } else if (overallStatus === "on_track") {
    headline = `On track — ${wishes.length} wish${wishes.length === 1 ? "" : "es"}, ${done.length} done.`;
  } else if (overallStatus === "at_risk") {
    headline = `At risk — ${deadlinesAtRisk} deadline${deadlinesAtRisk === 1 ? "" : "s"} at risk, ${mediumRisks} medium-severity issue${mediumRisks === 1 ? "" : "s"}.`;
  } else {
    headline = `Slipping — ${deadlinesMissed} deadline${deadlinesMissed === 1 ? "" : "s"} missed, ${highRisks} high-severity issue${highRisks === 1 ? "" : "s"}.`;
  }

  const paragraph =
    overallStatus === "no_data"
      ? "No wishes have been added to this planning project yet. Add deadlines, teams, and wishes to populate the roadmap."
      : `${wishes.length} wish${wishes.length === 1 ? "" : "es"} across ${teams.length} team${teams.length === 1 ? "" : "s"}: ${done.length} done (${completionPercent}%), ${inProgress.length} in progress, ${planned.length} planned. ` +
        `${deadlines.length} deadline${deadlines.length === 1 ? "" : "s"} (${deadlinesMissed} missed, ${deadlinesAtRisk} at risk, ${deadlineReports.filter((d) => d.status === "completed").length} completed, ${deadlineReports.filter((d) => d.status === "on_track").length} on track). ` +
        `${unscheduled.length} wish${unscheduled.length === 1 ? "" : "es"} still unscheduled. ` +
        `${highRisks} high, ${mediumRisks} medium-severity risk${highRisks + mediumRisks === 1 ? "" : "s"}.`;

  const totalDurationDaysPlanned = wishes
    .filter((w) => w.status !== "done")
    .reduce((sum, w) => sum + w.durationDays, 0);

  const summary: ReportSummary = {
    overallStatus,
    headline,
    paragraph,
    totals: {
      wishes: wishes.length,
      done: done.length,
      inProgress: inProgress.length,
      planned: planned.length,
      unscheduled: unscheduled.length,
      completionPercent,
      deadlines: deadlines.length,
      deadlinesAtRisk,
      deadlinesMissed,
      teams: teams.length,
      durationDaysPlanned: totalDurationDaysPlanned,
    },
  };

  // ── Comparison vs. previous ────────────────────────────────────────────
  let comparison: ReportComparison | undefined;
  if (
    opts.previous &&
    opts.previousReportId !== undefined &&
    opts.previousGeneratedAt !== undefined
  ) {
    const prev = opts.previous;
    const prevAtRisk =
      (prev.summary.totals.deadlinesAtRisk ?? 0) +
      (prev.summary.totals.deadlinesMissed ?? 0);
    const curAtRisk = deadlinesAtRisk + deadlinesMissed;
    const prevRiskKey = (r: { kind: string; wishId?: number }) =>
      `${r.kind}::${r.wishId ?? "_"}`;
    const prevRiskKeys = new Set(prev.risks.map(prevRiskKey));
    const curRiskKeys = new Set(risks.map(prevRiskKey));
    const newRisks = [...curRiskKeys].filter((k) => !prevRiskKeys.has(k))
      .length;
    const resolvedRisks = [...prevRiskKeys].filter(
      (k) => !curRiskKeys.has(k),
    ).length;

    const deltaWishesDone =
      done.length - (prev.summary.totals.done ?? 0);
    const deltaWishesAtRisk = curAtRisk - prevAtRisk;
    const deltaUnscheduled =
      unscheduled.length - (prev.summary.totals.unscheduled ?? 0);

    const parts: string[] = [];
    if (deltaWishesDone !== 0)
      parts.push(
        `${deltaWishesDone > 0 ? "+" : ""}${deltaWishesDone} wish${Math.abs(deltaWishesDone) === 1 ? "" : "es"} completed`,
      );
    if (newRisks > 0)
      parts.push(`${newRisks} new risk${newRisks === 1 ? "" : "s"}`);
    if (resolvedRisks > 0)
      parts.push(
        `${resolvedRisks} risk${resolvedRisks === 1 ? "" : "s"} resolved`,
      );
    if (deltaWishesAtRisk !== 0)
      parts.push(
        `${deltaWishesAtRisk > 0 ? "+" : ""}${deltaWishesAtRisk} deadline at-risk delta`,
      );
    const summaryLine =
      parts.length === 0 ? "No material changes." : parts.join("; ") + ".";

    comparison = {
      previousReportId: opts.previousReportId,
      previousGeneratedAt: opts.previousGeneratedAt,
      deltaWishesDone,
      deltaWishesAtRisk,
      deltaUnscheduled,
      newRisks,
      resolvedRisks,
      summary: summaryLine,
    };
  }

  return {
    generatedAt: now,
    planningProject: {
      id: pp.id,
      name: pp.name,
      description: pp.description,
      startDate: pp.startDate,
    },
    summary,
    deadlines: deadlineReports,
    teams: teamReports,
    risks,
    gaps,
    upcoming,
    comparison,
  };
}

// ── Markdown rendering ─────────────────────────────────────────────────────

function statusLabel(s: ReportOverallStatus): string {
  return s === "on_track"
    ? "On track"
    : s === "at_risk"
      ? "At risk"
      : s === "slipping"
        ? "Slipping"
        : "No data";
}

function deadlineLabel(s: ReportDeadlineStatus): string {
  return s === "completed"
    ? "Completed"
    : s === "on_track"
      ? "On track"
      : s === "at_risk"
        ? "At risk"
        : s === "missed"
          ? "Missed"
          : "—";
}

function severityLabel(s: ReportRiskSeverity): string {
  return s === "high" ? "High" : s === "medium" ? "Medium" : "Low";
}

function escMd(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export interface RenderMarkdownOpts {
  /** Optional generator label ("Christiaan Siebeling" or "Scheduled snapshot"). */
  generatedBy?: string;
}

export function renderReportMarkdown(
  payload: ReportPayload,
  opts: RenderMarkdownOpts = {},
): string {
  const generatedAtIso = new Date(payload.generatedAt).toISOString();
  const lines: string[] = [];
  lines.push(`# Roadmap status — ${payload.planningProject.name}`);
  lines.push("");
  lines.push(
    `**Generated:** ${generatedAtIso}` +
      (opts.generatedBy ? ` · by ${opts.generatedBy}` : ""),
  );
  lines.push(`**Status:** ${statusLabel(payload.summary.overallStatus)}`);
  if (payload.planningProject.startDate)
    lines.push(`**Project start:** ${payload.planningProject.startDate}`);
  if (payload.planningProject.description)
    lines.push(``, `> ${payload.planningProject.description}`);

  // 1. Executive summary
  lines.push("", "## Executive summary", "", payload.summary.headline);
  lines.push("", payload.summary.paragraph);
  if (payload.comparison) {
    lines.push(
      "",
      `**Since last snapshot** (${new Date(payload.comparison.previousGeneratedAt).toISOString()}): ${payload.comparison.summary}`,
    );
  }

  // 2. Deadlines
  lines.push("", "## Deadlines", "");
  if (payload.deadlines.length === 0) {
    lines.push("_No deadlines defined yet._");
  } else {
    lines.push(
      `| Deadline | Due | Status | Days until | Wishes (done / at risk / total) | Worst overrun |`,
    );
    lines.push(`|---|---|---|---|---|---|`);
    for (const d of payload.deadlines) {
      lines.push(
        `| ${escMd(d.name)} | ${d.dueDate} | ${deadlineLabel(d.status)} | ${d.daysUntilDue >= 0 ? `+${d.daysUntilDue}` : d.daysUntilDue} | ${d.wishesDone} / ${d.wishesAtRisk} / ${d.wishesLinked} | ${d.worstOverrunDays > 0 ? `${d.worstOverrunDays}d` : "—"} |`,
      );
    }
  }

  // 3. Teams
  lines.push("", "## Team workload", "");
  if (payload.teams.length === 0) {
    lines.push("_No teams defined yet._");
  } else {
    lines.push(
      `| Team | Members | Capacity | Active | Queued | Done | Unscheduled | Open work (days) | Estimated working days |`,
    );
    lines.push(`|---|---|---|---|---|---|---|---|---|`);
    for (const t of payload.teams) {
      lines.push(
        `| ${escMd(t.name)} | ${t.members} | ${t.maxParallel} | ${t.activeWishes} | ${t.queuedWishes} | ${t.doneWishes} | ${t.unscheduledWishes} | ${t.totalDurationDaysOpen} | ${t.estimatedWorkingDaysOfWork} |`,
      );
    }
  }

  // 4. Risks
  lines.push("", "## Risks", "");
  if (payload.risks.length === 0) {
    lines.push("_No risks detected. The current plan looks healthy._");
  } else {
    for (const r of payload.risks) {
      lines.push(
        `- **${severityLabel(r.severity)}** · ${r.kind} · _${escMd(r.title)}_: ${escMd(r.detail)}`,
      );
    }
  }

  // 5. Coverage gaps
  lines.push("", "## Coverage gaps", "");
  const g = payload.gaps;
  const gapBullets: string[] = [];
  if (g.wishesWithoutTeam.length > 0)
    gapBullets.push(
      `**${g.wishesWithoutTeam.length} wish${g.wishesWithoutTeam.length === 1 ? "" : "es"}** without a team: ${g.wishesWithoutTeam.map((w) => escMd(w.title)).join(", ")}`,
    );
  if (g.wishesWithoutDeadline.length > 0)
    gapBullets.push(
      `**${g.wishesWithoutDeadline.length} wish${g.wishesWithoutDeadline.length === 1 ? "" : "es"}** without a deadline: ${g.wishesWithoutDeadline.map((w) => escMd(w.title)).join(", ")}`,
    );
  if (g.unscheduledWishes.length > 0)
    gapBullets.push(
      `**${g.unscheduledWishes.length} unscheduled wish${g.unscheduledWishes.length === 1 ? "" : "es"}**: ${g.unscheduledWishes.map((w) => escMd(w.title)).join(", ")}`,
    );
  if (g.deadlinesWithoutWishes.length > 0)
    gapBullets.push(
      `**${g.deadlinesWithoutWishes.length} deadline${g.deadlinesWithoutWishes.length === 1 ? "" : "s"}** without linked wishes: ${g.deadlinesWithoutWishes.map((d) => `${escMd(d.name)} (${d.dueDate})`).join(", ")}`,
    );
  if (g.unusedTags.length > 0)
    gapBullets.push(
      `**${g.unusedTags.length} unused tag${g.unusedTags.length === 1 ? "" : "s"}**: ${g.unusedTags.map((t) => escMd(t.name)).join(", ")}`,
    );
  if (g.teamsWithoutMembers.length > 0)
    gapBullets.push(
      `**${g.teamsWithoutMembers.length} team${g.teamsWithoutMembers.length === 1 ? "" : "s"}** without members (no notification fan-out): ${g.teamsWithoutMembers.map((t) => escMd(t.name)).join(", ")}`,
    );
  if (gapBullets.length === 0) {
    lines.push("_No coverage gaps detected._");
  } else {
    for (const b of gapBullets) lines.push(`- ${b}`);
  }

  // 6. Upcoming
  lines.push("", `## Upcoming (next ${payload.upcoming.windowDays} days)`, "");
  if (
    payload.upcoming.startingSoon.length === 0 &&
    payload.upcoming.endingSoon.length === 0 &&
    payload.upcoming.deadlinesSoon.length === 0
  ) {
    lines.push("_Nothing scheduled in the upcoming window._");
  }
  if (payload.upcoming.deadlinesSoon.length > 0) {
    lines.push("**Deadlines:**");
    for (const d of payload.upcoming.deadlinesSoon)
      lines.push(`- ${d.dueDate} — ${escMd(d.name)}`);
    lines.push("");
  }
  if (payload.upcoming.startingSoon.length > 0) {
    lines.push("**Starting:**");
    for (const it of payload.upcoming.startingSoon)
      lines.push(
        `- ${it.date} — ${escMd(it.title)}${it.team ? ` (${escMd(it.team)})` : ""}`,
      );
    lines.push("");
  }
  if (payload.upcoming.endingSoon.length > 0) {
    lines.push("**Finishing:**");
    for (const it of payload.upcoming.endingSoon)
      lines.push(
        `- ${it.date} — ${escMd(it.title)}${it.team ? ` (${escMd(it.team)})` : ""}`,
      );
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

/** Headline string used in the snapshot picker — short + scannable. */
export function buildHeadline(payload: ReportPayload): string {
  return `${statusLabel(payload.summary.overallStatus)} — ${payload.summary.headline}`;
}
