/**
 * Planning tags — first-class typing entity inside a planning project.
 * Wishes attach to tags via planning_wish_tags (M:N). Wishes can also list
 * tag *names* in their `depends_on_tags` JSON to express "every wish
 * carrying tag X must finish before me".
 */

import type { Database } from "bun:sqlite";
import { registerTrashable, softDelete } from "./trash.ts";

registerTrashable({
  kind: "planning_tag",
  table: "planning_tags",
  nameColumn: "name",
  hasUniqueName: true,
  scopeColumn: "planning_project_id",
  translationSidecarTable: null,
  translationSidecarFk: null,
});

export interface PlanningTag {
  id: number;
  planningProjectId: number;
  project: string;
  name: string;
  description: string;
  color: string | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

interface TagRow {
  id: number;
  planning_project_id: number;
  project: string;
  name: string;
  description: string;
  color: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

function rowToTag(r: TagRow): PlanningTag {
  return {
    id: r.id,
    planningProjectId: r.planning_project_id,
    project: r.project,
    name: r.name,
    description: r.description,
    color: r.color,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const SELECT_COLS = `id, planning_project_id, project, name, description,
                     color, created_by, created_at, updated_at`;

export function listTags(
  db: Database,
  planningProjectId: number,
): PlanningTag[] {
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLS} FROM planning_tags
        WHERE planning_project_id = ? AND deleted_at IS NULL
        ORDER BY name ASC`,
    )
    .all(planningProjectId) as TagRow[];
  return rows.map(rowToTag);
}

export function getTag(db: Database, id: number): PlanningTag | null {
  const row = db
    .prepare(
      `SELECT ${SELECT_COLS} FROM planning_tags
        WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(id) as TagRow | undefined;
  return row ? rowToTag(row) : null;
}

export interface CreateTagOpts {
  planningProjectId: number;
  project: string;
  name: string;
  description?: string;
  color?: string | null;
  createdBy: string;
}

export function createTag(db: Database, opts: CreateTagOpts): PlanningTag {
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO planning_tags(planning_project_id, project, name,
                                 description, color, created_by,
                                 created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.planningProjectId,
      opts.project,
      opts.name,
      opts.description ?? "",
      opts.color ?? null,
      opts.createdBy,
      now,
      now,
    );
  return getTag(db, Number(info.lastInsertRowid))!;
}

export interface UpdateTagPatch {
  name?: string;
  description?: string;
  color?: string | null;
}

export function updateTag(
  db: Database,
  id: number,
  patch: UpdateTagPatch,
): PlanningTag {
  const existing = getTag(db, id);
  if (!existing) throw new Error(`tag ${id} not found`);
  const name = patch.name === undefined ? existing.name : patch.name;
  const description =
    patch.description === undefined ? existing.description : patch.description;
  const color = patch.color === undefined ? existing.color : patch.color;
  db.prepare(
    `UPDATE planning_tags
       SET name = ?, description = ?, color = ?, updated_at = ?
     WHERE id = ?`,
  ).run(name, description, color, Date.now(), id);
  return getTag(db, id)!;
}

export function deleteTag(
  db: Database,
  id: number,
  deletedBy: string | null = null,
): void {
  softDelete(db, "planning_tag", id, deletedBy);
}
