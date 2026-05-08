/**
 * Planning reports — periodic snapshots of the executive-grade roadmap
 * status. Inserts auto-prune to the configured cap (default 50) so the
 * picker stays bounded while keeping a reasonable history for trend
 * comparison.
 *
 * The full payload + rendered markdown live on the row so a saved snapshot
 * is reproducible after the underlying wishes/teams have moved on.
 */

import type { Database } from "bun:sqlite";

export const DEFAULT_MAX_REPORTS_PER_PROJECT = 50;

export type ReportTrigger = "manual" | "scheduled";

export interface PlanningReport {
  id: number;
  planningProjectId: number;
  generatedAt: number;
  trigger: ReportTrigger;
  generatedByUserId: string | null;
  payload: unknown; // typed in src/planning/report.ts
  markdown: string;
  headline: string;
}

interface ReportRow {
  id: number;
  planning_project_id: number;
  generated_at: number;
  trigger: string;
  generated_by_user_id: string | null;
  payload_json: string;
  markdown: string;
  headline: string;
}

function rowToReport(r: ReportRow): PlanningReport {
  let payload: unknown = {};
  try {
    payload = JSON.parse(r.payload_json);
  } catch {
    // Corrupt payload — keep an empty object so the picker stays usable.
  }
  const trigger: ReportTrigger =
    r.trigger === "scheduled" ? "scheduled" : "manual";
  return {
    id: r.id,
    planningProjectId: r.planning_project_id,
    generatedAt: r.generated_at,
    trigger,
    generatedByUserId: r.generated_by_user_id,
    payload,
    markdown: r.markdown,
    headline: r.headline,
  };
}

const SELECT_COLS = `id, planning_project_id, generated_at, trigger,
                     generated_by_user_id, payload_json, markdown, headline`;

export interface CreateReportOpts {
  planningProjectId: number;
  trigger: ReportTrigger;
  generatedByUserId: string | null;
  payload: unknown;
  markdown: string;
  headline: string;
  /** Cap for the rolling window of saved reports. Older rows are pruned. */
  maxRows?: number;
}

export function createReport(
  db: Database,
  opts: CreateReportOpts,
): PlanningReport {
  const cap = Math.max(1, opts.maxRows ?? DEFAULT_MAX_REPORTS_PER_PROJECT);
  const tx = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO planning_reports(planning_project_id, generated_at,
                                      trigger, generated_by_user_id,
                                      payload_json, markdown, headline)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        opts.planningProjectId,
        Date.now(),
        opts.trigger,
        opts.generatedByUserId,
        JSON.stringify(opts.payload),
        opts.markdown,
        opts.headline,
      );
    const id = Number(info.lastInsertRowid);
    // Prune oldest rows beyond `cap`.
    db.prepare(
      `DELETE FROM planning_reports
        WHERE planning_project_id = ?
          AND id NOT IN (
            SELECT id FROM planning_reports
              WHERE planning_project_id = ?
              ORDER BY generated_at DESC
              LIMIT ?
          )`,
    ).run(opts.planningProjectId, opts.planningProjectId, cap);
    return id;
  });
  return getReport(db, tx())!;
}

export function getReport(db: Database, id: number): PlanningReport | null {
  const row = db
    .prepare(`SELECT ${SELECT_COLS} FROM planning_reports WHERE id = ?`)
    .get(id) as ReportRow | undefined;
  return row ? rowToReport(row) : null;
}

export function getLatestReport(
  db: Database,
  planningProjectId: number,
): PlanningReport | null {
  const row = db
    .prepare(
      `SELECT ${SELECT_COLS} FROM planning_reports
        WHERE planning_project_id = ?
        ORDER BY generated_at DESC
        LIMIT 1`,
    )
    .get(planningProjectId) as ReportRow | undefined;
  return row ? rowToReport(row) : null;
}

export interface ReportListItem {
  id: number;
  generatedAt: number;
  trigger: ReportTrigger;
  generatedByUserId: string | null;
  headline: string;
}

/**
 * List reports newest-first. Returns lightweight rows (no payload/markdown)
 * so the picker stays cheap.
 */
export function listReports(
  db: Database,
  planningProjectId: number,
  limit: number = DEFAULT_MAX_REPORTS_PER_PROJECT,
): ReportListItem[] {
  const rows = db
    .prepare(
      `SELECT id, generated_at, trigger, generated_by_user_id, headline
         FROM planning_reports
         WHERE planning_project_id = ?
         ORDER BY generated_at DESC
         LIMIT ?`,
    )
    .all(planningProjectId, limit) as Array<{
    id: number;
    generated_at: number;
    trigger: string;
    generated_by_user_id: string | null;
    headline: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    generatedAt: r.generated_at,
    trigger: r.trigger === "scheduled" ? "scheduled" : "manual",
    generatedByUserId: r.generated_by_user_id,
    headline: r.headline,
  }));
}
