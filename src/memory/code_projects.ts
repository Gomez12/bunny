/**
 * Per-Bunny-project code areas — DB CRUD + status setters + permission helper.
 * On-disk directory is managed by the clone subsystem (`src/code/clone.ts`)
 * and reuses the existing workspace primitives.
 */

import type { Database } from "bun:sqlite";
import type { Project } from "./projects.ts";
import type { User } from "../auth/users.ts";
import { validateSlugName } from "./slug.ts";
import { registerTrashable, softDelete } from "./trash.ts";

/** Slug rule for code-project names. Doubles as a filesystem directory name. */
export const CODE_PROJECT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function validateCodeProjectName(raw: unknown): string {
  return validateSlugName(raw, CODE_PROJECT_NAME_RE, "code project");
}

registerTrashable({
  kind: "code_project",
  table: "code_projects",
  nameColumn: "name",
  hasUniqueName: true,
  translationSidecarTable: null,
  translationSidecarFk: null,
});

export type GitStatus = "idle" | "cloning" | "ready" | "error";

export interface CodeProject {
  id: number;
  project: string;
  name: string;
  description: string;
  gitUrl: string | null;
  gitRef: string | null;
  gitStatus: GitStatus;
  gitError: string | null;
  lastClonedAt: number | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

interface CodeProjectRow {
  id: number;
  project: string;
  name: string;
  description: string;
  git_url: string | null;
  git_ref: string | null;
  git_status: string;
  git_error: string | null;
  last_cloned_at: number | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

function rowToCodeProject(r: CodeProjectRow): CodeProject {
  const status: GitStatus =
    r.git_status === "cloning" ||
    r.git_status === "ready" ||
    r.git_status === "error"
      ? r.git_status
      : "idle";
  return {
    id: r.id,
    project: r.project,
    name: r.name,
    description: r.description,
    gitUrl: r.git_url,
    gitRef: r.git_ref,
    gitStatus: status,
    gitError: r.git_error,
    lastClonedAt: r.last_cloned_at,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const SELECT_COLS = `id, project, name, description, git_url, git_ref,
                     git_status, git_error, last_cloned_at,
                     created_by, created_at, updated_at`;

export function listCodeProjects(db: Database, project: string): CodeProject[] {
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLS} FROM code_projects
        WHERE project = ? AND deleted_at IS NULL
        ORDER BY updated_at DESC`,
    )
    .all(project) as CodeProjectRow[];
  return rows.map(rowToCodeProject);
}

export function getCodeProject(db: Database, id: number): CodeProject | null {
  const row = db
    .prepare(
      `SELECT ${SELECT_COLS} FROM code_projects
        WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(id) as CodeProjectRow | undefined;
  return row ? rowToCodeProject(row) : null;
}

export interface CreateCodeProjectOpts {
  project: string;
  name: string;
  description?: string;
  gitUrl?: string | null;
  gitRef?: string | null;
  createdBy: string;
}

export function createCodeProject(
  db: Database,
  opts: CreateCodeProjectOpts,
): CodeProject {
  const name = validateCodeProjectName(opts.name);
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO code_projects(project, name, description, git_url, git_ref,
                                 git_status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.project,
      name,
      opts.description ?? "",
      opts.gitUrl ?? null,
      opts.gitRef ?? null,
      opts.gitUrl ? "cloning" : "idle",
      opts.createdBy,
      now,
      now,
    );
  const id = Number(info.lastInsertRowid);
  return getCodeProject(db, id)!;
}

export interface UpdateCodeProjectPatch {
  description?: string;
  gitRef?: string | null;
}

export function updateCodeProject(
  db: Database,
  id: number,
  patch: UpdateCodeProjectPatch,
): CodeProject {
  const existing = getCodeProject(db, id);
  if (!existing) throw new Error(`code project ${id} not found`);
  const description =
    patch.description === undefined ? existing.description : patch.description;
  const gitRef = patch.gitRef === undefined ? existing.gitRef : patch.gitRef;
  db.prepare(
    `UPDATE code_projects
       SET description = ?, git_ref = ?, updated_at = ?
     WHERE id = ?`,
  ).run(description, gitRef, Date.now(), id);
  return getCodeProject(db, id)!;
}

export function deleteCodeProject(
  db: Database,
  id: number,
  deletedBy: string | null = null,
): void {
  softDelete(db, "code_project", id, deletedBy);
}

export function canEditCodeProject(
  user: User,
  cp: CodeProject,
  project: Project,
): boolean {
  if (user.role === "admin") return true;
  if (project.createdBy && project.createdBy === user.id) return true;
  if (cp.createdBy === user.id) return true;
  return false;
}

// ── Git status setters ──────────────────────────────────────────────────────
// These guard against lost races by only transitioning from expected states.

/**
 * Flip an idle/error row to `cloning`. Returns true when the transition was
 * applied; false when another caller already claimed the row.
 */
export function setGitCloning(db: Database, id: number): boolean {
  const info = db
    .prepare(
      `UPDATE code_projects
          SET git_status = 'cloning',
              git_error  = NULL,
              updated_at = ?
        WHERE id = ?
          AND deleted_at IS NULL
          AND git_status != 'cloning'`,
    )
    .run(Date.now(), id);
  return info.changes > 0;
}

export function setGitReady(db: Database, id: number): void {
  const now = Date.now();
  db.prepare(
    `UPDATE code_projects
        SET git_status     = 'ready',
            git_error      = NULL,
            last_cloned_at = ?,
            updated_at     = ?
      WHERE id = ?`,
  ).run(now, now, id);
}

export function setGitError(db: Database, id: number, error: string): void {
  db.prepare(
    `UPDATE code_projects
        SET git_status = 'error',
            git_error  = ?,
            updated_at = ?
      WHERE id = ?`,
  ).run(error, Date.now(), id);
}

export function setGitIdle(db: Database, id: number): void {
  db.prepare(
    `UPDATE code_projects
        SET git_status = 'idle',
            git_error  = NULL,
            updated_at = ?
      WHERE id = ?`,
  ).run(Date.now(), id);
}
