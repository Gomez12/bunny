/**
 * Planning projects — top-level entity in the Planning module. Each row
 * groups its own deadlines / teams / tags / wishes (see siblings). Mirrors
 * the code-projects pattern: per-Bunny-project sub-application with a slug
 * name + soft-delete via the trash registry.
 */

import type { Database } from "bun:sqlite";
import type { Project } from "./projects.ts";
import type { User } from "../auth/users.ts";
import { validateSlugName } from "./slug.ts";
import { registerTrashable, softDelete } from "./trash.ts";

export const PLANNING_PROJECT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function validatePlanningProjectName(raw: unknown): string {
  return validateSlugName(raw, PLANNING_PROJECT_NAME_RE, "planning project");
}

registerTrashable({
  kind: "planning_project",
  table: "planning_projects",
  nameColumn: "name",
  hasUniqueName: true,
  translationSidecarTable: null,
  translationSidecarFk: null,
});

export interface PlanningProject {
  id: number;
  project: string;
  name: string;
  description: string;
  startDate: string | null;
  /** Sprint cadence in working days. null/0 = sprints off (no indicators). */
  sprintDurationDays: number | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

interface PlanningProjectRow {
  id: number;
  project: string;
  name: string;
  description: string;
  start_date: string | null;
  sprint_duration_days: number | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

function rowToPlanningProject(r: PlanningProjectRow): PlanningProject {
  return {
    id: r.id,
    project: r.project,
    name: r.name,
    description: r.description,
    startDate: r.start_date,
    sprintDurationDays:
      r.sprint_duration_days && r.sprint_duration_days > 0
        ? r.sprint_duration_days
        : null,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const SELECT_COLS = `id, project, name, description, start_date,
                     sprint_duration_days,
                     created_by, created_at, updated_at`;

function clampSprintDuration(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n > 999) return 999;
  return Math.floor(n);
}

export function listPlanningProjects(
  db: Database,
  project: string,
): PlanningProject[] {
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLS} FROM planning_projects
        WHERE project = ? AND deleted_at IS NULL
        ORDER BY updated_at DESC`,
    )
    .all(project) as PlanningProjectRow[];
  return rows.map(rowToPlanningProject);
}

export function getPlanningProject(
  db: Database,
  id: number,
): PlanningProject | null {
  const row = db
    .prepare(
      `SELECT ${SELECT_COLS} FROM planning_projects
        WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(id) as PlanningProjectRow | undefined;
  return row ? rowToPlanningProject(row) : null;
}

export interface CreatePlanningProjectOpts {
  project: string;
  name: string;
  description?: string;
  startDate?: string | null;
  sprintDurationDays?: number | null;
  createdBy: string;
}

export function createPlanningProject(
  db: Database,
  opts: CreatePlanningProjectOpts,
): PlanningProject {
  const name = validatePlanningProjectName(opts.name);
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO planning_projects(project, name, description, start_date,
                                     sprint_duration_days,
                                     created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.project,
      name,
      opts.description ?? "",
      opts.startDate ?? null,
      clampSprintDuration(opts.sprintDurationDays),
      opts.createdBy,
      now,
      now,
    );
  const id = Number(info.lastInsertRowid);
  return getPlanningProject(db, id)!;
}

export interface UpdatePlanningProjectPatch {
  description?: string;
  startDate?: string | null;
  sprintDurationDays?: number | null;
}

export function updatePlanningProject(
  db: Database,
  id: number,
  patch: UpdatePlanningProjectPatch,
): PlanningProject {
  const existing = getPlanningProject(db, id);
  if (!existing) throw new Error(`planning project ${id} not found`);
  const description =
    patch.description === undefined ? existing.description : patch.description;
  const startDate =
    patch.startDate === undefined ? existing.startDate : patch.startDate;
  const sprintDurationDays =
    patch.sprintDurationDays === undefined
      ? existing.sprintDurationDays
      : clampSprintDuration(patch.sprintDurationDays);
  db.prepare(
    `UPDATE planning_projects
       SET description = ?, start_date = ?, sprint_duration_days = ?, updated_at = ?
     WHERE id = ?`,
  ).run(description, startDate, sprintDurationDays, Date.now(), id);
  return getPlanningProject(db, id)!;
}

export function deletePlanningProject(
  db: Database,
  id: number,
  deletedBy: string | null = null,
): void {
  softDelete(db, "planning_project", id, deletedBy);
}

export function canEditPlanningProject(
  user: User,
  pp: PlanningProject,
  project: Project,
): boolean {
  if (user.role === "admin") return true;
  if (project.createdBy && project.createdBy === user.id) return true;
  if (pp.createdBy === user.id) return true;
  return false;
}
