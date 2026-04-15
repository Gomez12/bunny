/**
 * Project registry — CRUD over the `projects` table.
 *
 * A project is both a DB row (metadata) and a directory under
 * `$BUNNY_HOME/projects/<name>/` (prompt + future skills/shortcuts). This
 * module owns the DB side; `project_assets.ts` owns the disk side.
 *
 * Project names are the PK and a directory name, so they are immutable and
 * validated strictly (see {@link validateProjectName}).
 */

import type { Database } from "bun:sqlite";

export type ProjectVisibility = "public" | "private";

export interface Project {
  name: string;
  description: string | null;
  visibility: ProjectVisibility;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

export const DEFAULT_PROJECT = "general";

import { PROJECT_NAME_RE } from "./project_name.ts";
import { validateSlugName } from "./slug.ts";
import { seedDefaultSwimlanes } from "./board_swimlanes.ts";

export { PROJECT_NAME_RE };

/** Validate and normalise a project name. Throws on invalid input. */
export function validateProjectName(raw: unknown): string {
  return validateSlugName(raw, PROJECT_NAME_RE, "project");
}

interface ProjectRow {
  name: string;
  description: string | null;
  visibility: string;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

function rowToProject(r: ProjectRow): Project {
  return {
    name: r.name,
    description: r.description,
    visibility: (r.visibility === "private" ? "private" : "public") as ProjectVisibility,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function listProjects(db: Database): Project[] {
  const rows = db
    .prepare(`SELECT name, description, visibility, created_by, created_at, updated_at FROM projects ORDER BY name ASC`)
    .all() as ProjectRow[];
  return rows.map(rowToProject);
}

export function getProject(db: Database, name: string): Project | null {
  const row = db
    .prepare(`SELECT name, description, visibility, created_by, created_at, updated_at FROM projects WHERE name = ?`)
    .get(name) as ProjectRow | undefined;
  return row ? rowToProject(row) : null;
}

export interface CreateProjectOpts {
  name: string;
  description?: string | null;
  visibility?: ProjectVisibility;
  createdBy?: string | null;
}

export function createProject(db: Database, opts: CreateProjectOpts): Project {
  const name = validateProjectName(opts.name);
  const now = Date.now();
  db.prepare(
    `INSERT INTO projects(name, description, visibility, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    name,
    opts.description ?? null,
    opts.visibility ?? "public",
    opts.createdBy ?? null,
    now,
    now,
  );
  seedDefaultSwimlanes(db, name);
  return getProject(db, name)!;
}

export interface UpdateProjectPatch {
  description?: string | null;
  visibility?: ProjectVisibility;
}

export function updateProject(db: Database, name: string, patch: UpdateProjectPatch): Project {
  const existing = getProject(db, name);
  if (!existing) throw new Error(`project '${name}' not found`);
  const description = patch.description === undefined ? existing.description : patch.description;
  const visibility = patch.visibility ?? existing.visibility;
  db.prepare(
    `UPDATE projects SET description = ?, visibility = ?, updated_at = ? WHERE name = ?`,
  ).run(description, visibility, Date.now(), name);
  return getProject(db, name)!;
}

export function deleteProject(db: Database, name: string): void {
  if (name === DEFAULT_PROJECT) throw new Error(`cannot delete the default '${DEFAULT_PROJECT}' project`);
  db.prepare(`DELETE FROM projects WHERE name = ?`).run(name);
}

/**
 * Return the project a session is already bound to, or `null` when the session
 * has no messages yet. Legacy NULL `project` columns coalesce to
 * {@link DEFAULT_PROJECT}. Callers use `null` to decide whether to accept a
 * caller-supplied project vs. enforce the existing one.
 */
export function getSessionProject(db: Database, sessionId: string): string | null {
  const row = db
    .prepare(
      `SELECT COALESCE(project, ?) AS project FROM messages WHERE session_id = ? LIMIT 1`,
    )
    .get(DEFAULT_PROJECT, sessionId) as { project: string } | undefined;
  return row?.project ?? null;
}

/** Ensure a project row exists; create with defaults if missing. Returns the row. */
export function ensureProject(db: Database, name: string, createdBy?: string | null): Project {
  const validated = validateProjectName(name);
  const existing = getProject(db, validated);
  if (existing) return existing;
  return createProject(db, { name: validated, createdBy: createdBy ?? null });
}
