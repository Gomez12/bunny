/**
 * Scheduler handler: weekly executive report snapshot per planning project.
 *
 * Walks all alive planning projects that have at least one wish and creates
 * a snapshot. Empty projects are skipped to keep the history meaningful.
 * The previous snapshot's payload (if any) feeds the comparison section so
 * the user sees deltas since last week.
 */

import type { Database } from "bun:sqlite";
import type {
  HandlerRegistry,
  TaskHandlerContext,
} from "../scheduler/handlers.ts";
import { errorDetails } from "../util/error.ts";
import {
  buildHeadline,
  buildReportPayload,
  renderReportMarkdown,
  type ReportPayload,
} from "./report.ts";
import { createReport, getLatestReport } from "../memory/planning_reports.ts";

export const PLANNING_REPORT_SNAPSHOT_HANDLER = "planning.report_snapshot";

interface ProjectRow {
  id: number;
  wish_count: number;
}

function selectActivePlanningProjectIds(db: Database): number[] {
  const rows = db
    .prepare(
      `SELECT pp.id AS id,
              COUNT(w.id) AS wish_count
         FROM planning_projects pp
         LEFT JOIN planning_wishes w
           ON w.planning_project_id = pp.id AND w.deleted_at IS NULL
         WHERE pp.deleted_at IS NULL
         GROUP BY pp.id
         HAVING wish_count > 0
         ORDER BY pp.updated_at DESC`,
    )
    .all() as ProjectRow[];
  return rows.map((r) => r.id);
}

/**
 * Build + persist one snapshot for a planning project. Exported so the HTTP
 * "Generate now" endpoint reuses the same path.
 */
export function buildAndStoreReport(
  db: Database,
  planningProjectId: number,
  trigger: "manual" | "scheduled",
  generatedByUserId: string | null,
  maxRows: number,
  generatedByLabel: string | undefined,
): { reportId: number; payload: ReportPayload } | null {
  const previous = getLatestReport(db, planningProjectId);
  const previousPayload =
    previous && previous.payload && typeof previous.payload === "object"
      ? (previous.payload as ReportPayload)
      : null;
  const payload = buildReportPayload(db, planningProjectId, {
    previous: previousPayload,
    previousReportId: previous?.id,
    previousGeneratedAt: previous?.generatedAt,
  });
  if (!payload) return null;
  const markdown = renderReportMarkdown(payload, {
    generatedBy: generatedByLabel,
  });
  const headline = buildHeadline(payload);
  const row = createReport(db, {
    planningProjectId,
    trigger,
    generatedByUserId,
    payload,
    markdown,
    headline,
    maxRows,
  });
  return { reportId: row.id, payload };
}

export async function planningReportSnapshotHandler(
  ctx: TaskHandlerContext,
): Promise<void> {
  const { db, queue, cfg } = ctx;
  if (!cfg.planning.reportSnapshotEnabled) return;
  const ids = selectActivePlanningProjectIds(db);
  if (ids.length === 0) return;
  for (const id of ids) {
    try {
      const r = buildAndStoreReport(
        db,
        id,
        "scheduled",
        null,
        cfg.planning.maxReportsPerProject,
        "Scheduled snapshot",
      );
      if (r) {
        void queue.log({
          topic: "planning",
          kind: "report.snapshot",
          data: {
            planningProjectId: id,
            reportId: r.reportId,
            status: r.payload.summary.overallStatus,
          },
        });
      }
    } catch (e) {
      void queue.log({
        topic: "planning",
        kind: "report.snapshot.error",
        data: { planningProjectId: id },
        error: errorDetails(e),
      });
    }
  }
}

export function registerPlanningReportSnapshot(
  registry: HandlerRegistry,
): void {
  registry.register(
    PLANNING_REPORT_SNAPSHOT_HANDLER,
    planningReportSnapshotHandler,
  );
}
