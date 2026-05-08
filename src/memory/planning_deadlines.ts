/**
 * Planning deadlines — fixed end-dates inside a planning project. Wishes
 * may reference one to bind their `planned_end_date` budget. Soft-delete uses
 * the planning_project_id scope so two deadlines with the same name can
 * coexist across different planning projects but still rename-on-delete to
 * keep UNIQUE(planning_project_id, name) intact.
 */

import type { Database } from "bun:sqlite";
import { registerTrashable, softDelete } from "./trash.ts";

registerTrashable({
  kind: "planning_deadline",
  table: "planning_deadlines",
  nameColumn: "name",
  hasUniqueName: true,
  scopeColumn: "planning_project_id",
  translationSidecarTable: null,
  translationSidecarFk: null,
});

export interface PlanningDeadline {
  id: number;
  planningProjectId: number;
  project: string;
  name: string;
  description: string;
  dueDate: string;          // ISO YYYY-MM-DD
  color: string | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

interface DeadlineRow {
  id: number;
  planning_project_id: number;
  project: string;
  name: string;
  description: string;
  due_date: string;
  color: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

function rowToDeadline(r: DeadlineRow): PlanningDeadline {
  return {
    id: r.id,
    planningProjectId: r.planning_project_id,
    project: r.project,
    name: r.name,
    description: r.description,
    dueDate: r.due_date,
    color: r.color,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function validateIsoDate(raw: unknown, label: string): string {
  if (typeof raw !== "string" || !ISO_DATE_RE.test(raw))
    throw new Error(`${label} must be an ISO YYYY-MM-DD date`);
  return raw;
}

const SELECT_COLS = `id, planning_project_id, project, name, description,
                     due_date, color, created_by, created_at, updated_at`;

export function listDeadlines(
  db: Database,
  planningProjectId: number,
): PlanningDeadline[] {
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLS} FROM planning_deadlines
        WHERE planning_project_id = ? AND deleted_at IS NULL
        ORDER BY due_date ASC`,
    )
    .all(planningProjectId) as DeadlineRow[];
  return rows.map(rowToDeadline);
}

export function getDeadline(
  db: Database,
  id: number,
): PlanningDeadline | null {
  const row = db
    .prepare(
      `SELECT ${SELECT_COLS} FROM planning_deadlines
        WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(id) as DeadlineRow | undefined;
  return row ? rowToDeadline(row) : null;
}

export interface CreateDeadlineOpts {
  planningProjectId: number;
  project: string;
  name: string;
  description?: string;
  dueDate: string;
  color?: string | null;
  createdBy: string;
}

export function createDeadline(
  db: Database,
  opts: CreateDeadlineOpts,
): PlanningDeadline {
  const dueDate = validateIsoDate(opts.dueDate, "due_date");
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO planning_deadlines(planning_project_id, project, name,
                                      description, due_date, color,
                                      created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.planningProjectId,
      opts.project,
      opts.name,
      opts.description ?? "",
      dueDate,
      opts.color ?? null,
      opts.createdBy,
      now,
      now,
    );
  return getDeadline(db, Number(info.lastInsertRowid))!;
}

export interface UpdateDeadlinePatch {
  name?: string;
  description?: string;
  dueDate?: string;
  color?: string | null;
}

export function updateDeadline(
  db: Database,
  id: number,
  patch: UpdateDeadlinePatch,
): PlanningDeadline {
  const existing = getDeadline(db, id);
  if (!existing) throw new Error(`deadline ${id} not found`);
  const name = patch.name === undefined ? existing.name : patch.name;
  const description =
    patch.description === undefined ? existing.description : patch.description;
  const dueDate =
    patch.dueDate === undefined
      ? existing.dueDate
      : validateIsoDate(patch.dueDate, "due_date");
  const color = patch.color === undefined ? existing.color : patch.color;
  db.prepare(
    `UPDATE planning_deadlines
       SET name = ?, description = ?, due_date = ?, color = ?, updated_at = ?
     WHERE id = ?`,
  ).run(name, description, dueDate, color, Date.now(), id);
  return getDeadline(db, id)!;
}

export function deleteDeadline(
  db: Database,
  id: number,
  deletedBy: string | null = null,
): void {
  softDelete(db, "planning_deadline", id, deletedBy);
}
