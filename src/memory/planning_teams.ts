/**
 * Planning teams — execution units inside a planning project. Each team has
 * a `max_parallel` capacity used by the scheduler. Members are optional and
 * only consumed by the notification dispatcher (planning.wish.assigned,
 * planning.deadline.conflict).
 */

import type { Database } from "bun:sqlite";
import { registerTrashable, softDelete } from "./trash.ts";

registerTrashable({
  kind: "planning_team",
  table: "planning_teams",
  nameColumn: "name",
  hasUniqueName: true,
  scopeColumn: "planning_project_id",
  translationSidecarTable: null,
  translationSidecarFk: null,
});

export interface PlanningTeam {
  id: number;
  planningProjectId: number;
  project: string;
  name: string;
  description: string;
  color: string | null;
  maxParallel: number;
  members: string[]; // user ids; populated on demand by listTeams / getTeam
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

interface TeamRow {
  id: number;
  planning_project_id: number;
  project: string;
  name: string;
  description: string;
  color: string | null;
  max_parallel: number;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

function rowToTeam(r: TeamRow, members: string[]): PlanningTeam {
  return {
    id: r.id,
    planningProjectId: r.planning_project_id,
    project: r.project,
    name: r.name,
    description: r.description,
    color: r.color,
    maxParallel: r.max_parallel,
    members,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const SELECT_COLS = `id, planning_project_id, project, name, description,
                     color, max_parallel, created_by, created_at, updated_at`;

function loadMembers(db: Database, teamId: number): string[] {
  return (
    db
      .prepare(
        `SELECT user_id FROM planning_team_members
          WHERE planning_team_id = ?
          ORDER BY user_id`,
      )
      .all(teamId) as { user_id: string }[]
  ).map((r) => r.user_id);
}

function loadMembersFor(
  db: Database,
  teamIds: number[],
): Map<number, string[]> {
  const map = new Map<number, string[]>();
  if (teamIds.length === 0) return map;
  const placeholders = teamIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT planning_team_id, user_id FROM planning_team_members
        WHERE planning_team_id IN (${placeholders})
        ORDER BY user_id`,
    )
    .all(...teamIds) as { planning_team_id: number; user_id: string }[];
  for (const r of rows) {
    const list = map.get(r.planning_team_id);
    if (list) list.push(r.user_id);
    else map.set(r.planning_team_id, [r.user_id]);
  }
  return map;
}

export function listTeams(
  db: Database,
  planningProjectId: number,
): PlanningTeam[] {
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLS} FROM planning_teams
        WHERE planning_project_id = ? AND deleted_at IS NULL
        ORDER BY name ASC`,
    )
    .all(planningProjectId) as TeamRow[];
  const members = loadMembersFor(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => rowToTeam(r, members.get(r.id) ?? []));
}

export function getTeam(db: Database, id: number): PlanningTeam | null {
  const row = db
    .prepare(
      `SELECT ${SELECT_COLS} FROM planning_teams
        WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(id) as TeamRow | undefined;
  return row ? rowToTeam(row, loadMembers(db, row.id)) : null;
}

export interface CreateTeamOpts {
  planningProjectId: number;
  project: string;
  name: string;
  description?: string;
  color?: string | null;
  maxParallel?: number;
  members?: string[];
  createdBy: string;
}

function clampMaxParallel(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return 1;
  if (n > 100) return 100;
  return Math.floor(n);
}

export function createTeam(db: Database, opts: CreateTeamOpts): PlanningTeam {
  const maxParallel = clampMaxParallel(opts.maxParallel ?? 1);
  const now = Date.now();
  const tx = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO planning_teams(planning_project_id, project, name,
                                    description, color, max_parallel,
                                    created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        opts.planningProjectId,
        opts.project,
        opts.name,
        opts.description ?? "",
        opts.color ?? null,
        maxParallel,
        opts.createdBy,
        now,
        now,
      );
    const id = Number(info.lastInsertRowid);
    if (opts.members && opts.members.length > 0) {
      const stmt = db.prepare(
        `INSERT OR IGNORE INTO planning_team_members(planning_team_id, user_id, created_at)
         VALUES (?, ?, ?)`,
      );
      for (const userId of opts.members) stmt.run(id, userId, now);
    }
    return id;
  });
  return getTeam(db, tx())!;
}

export interface UpdateTeamPatch {
  name?: string;
  description?: string;
  color?: string | null;
  maxParallel?: number;
}

export function updateTeam(
  db: Database,
  id: number,
  patch: UpdateTeamPatch,
): PlanningTeam {
  const existing = getTeam(db, id);
  if (!existing) throw new Error(`team ${id} not found`);
  const name = patch.name === undefined ? existing.name : patch.name;
  const description =
    patch.description === undefined ? existing.description : patch.description;
  const color = patch.color === undefined ? existing.color : patch.color;
  const maxParallel =
    patch.maxParallel === undefined
      ? existing.maxParallel
      : clampMaxParallel(patch.maxParallel);
  db.prepare(
    `UPDATE planning_teams
       SET name = ?, description = ?, color = ?, max_parallel = ?, updated_at = ?
     WHERE id = ?`,
  ).run(name, description, color, maxParallel, Date.now(), id);
  return getTeam(db, id)!;
}

export function deleteTeam(
  db: Database,
  id: number,
  deletedBy: string | null = null,
): void {
  softDelete(db, "planning_team", id, deletedBy);
}

export function addTeamMember(
  db: Database,
  teamId: number,
  userId: string,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO planning_team_members(planning_team_id, user_id, created_at)
     VALUES (?, ?, ?)`,
  ).run(teamId, userId, Date.now());
}

export function removeTeamMember(
  db: Database,
  teamId: number,
  userId: string,
): void {
  db.prepare(
    `DELETE FROM planning_team_members
      WHERE planning_team_id = ? AND user_id = ?`,
  ).run(teamId, userId);
}

export function listTeamMembers(db: Database, teamId: number): string[] {
  return loadMembers(db, teamId);
}
