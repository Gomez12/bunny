/**
 * Permission helpers for `VersionableEntityDef.canSee` / `canEdit`. Kept in a
 * separate module to avoid pulling auth/server types into `versioning.ts`
 * itself — that module stays a pure data-layer concern.
 *
 * The route layer short-circuits admin BEFORE calling into these helpers, so
 * everything here only has to answer "may *this non-admin user* see/edit the
 * entity?". For project-scoped entities that maps to:
 *
 *   - canSee:  the project is public, or this user created the project.
 *   - canEdit: this user created the project, or this user created the
 *              entity row (matching the existing `canEditDocument`,
 *              `canEditContact`, etc. helpers in their memory modules).
 *
 * Inlined inline-style mirrors of `canSeeProject` / `canEditProject` keep
 * `versioning_access.ts` free of any `server/` imports — that direction
 * would form a cycle (server → memory → server).
 */

import type { Database } from "bun:sqlite";

interface ProjectRow {
  visibility: string;
  created_by: string | null;
}

function loadProject(
  db: Database,
  projectName: string,
): ProjectRow | undefined {
  return db
    .prepare(
      `SELECT visibility, created_by FROM projects WHERE name = ?`,
    )
    .get(projectName) as ProjectRow | undefined;
}

/**
 * Can `userId` *see* anything inside `projectName`?
 *
 * Public projects are visible to every authenticated user; private projects
 * only to their creator. Admin is handled at the route layer.
 */
export function canSeeProjectByName(
  db: Database,
  userId: string,
  projectName: string,
): boolean {
  const p = loadProject(db, projectName);
  if (!p) return false;
  if (p.visibility === "public") return true;
  return p.created_by === userId;
}

/**
 * Can `userId` *edit* anything inside `projectName`? Non-admin: only the
 * project creator.
 */
export function canEditProjectByName(
  db: Database,
  userId: string,
  projectName: string,
): boolean {
  const p = loadProject(db, projectName);
  if (!p) return false;
  return p.created_by === userId;
}

/**
 * Helper for kinds where the entity row carries a `project` text column.
 * Looks up the project name first, then delegates to
 * `canSeeProjectByName` / `canEditProjectByName`.
 */
export function projectScopedAccess(
  db: Database,
  userId: string,
  table: string,
  primaryKey: string,
  entityId: string,
  mode: "see" | "edit",
): boolean {
  const row = db
    .prepare(`SELECT project FROM ${table} WHERE ${primaryKey} = ?`)
    .get(coerce(entityId, primaryKey)) as { project: string } | undefined;
  if (!row) return false;
  return mode === "see"
    ? canSeeProjectByName(db, userId, row.project)
    : canEditProjectByName(db, userId, row.project);
}

/**
 * Most entity tables use integer ids; some (agents, skills) use string slugs
 * keyed by `name`. `SELECT … WHERE id = ?` works for both at SQL level, but
 * casting integer-shaped strings keeps prepared-statement caches warmer.
 */
function coerce(entityId: string, primaryKey: string): string | number {
  if (primaryKey === "id") {
    const n = Number(entityId);
    if (Number.isInteger(n) && !Number.isNaN(n)) return n;
  }
  return entityId;
}

/**
 * Helper for entities scoped to a single owning user (currently only
 * `scheduled_tasks` with its `owner_user_id` column). Returns true iff
 * `userId` matches the row's owner.
 */
export function ownerScopedAccess(
  db: Database,
  userId: string,
  table: string,
  primaryKey: string,
  ownerColumn: string,
  entityId: string,
): boolean {
  const row = db
    .prepare(`SELECT ${ownerColumn} AS owner FROM ${table} WHERE ${primaryKey} = ?`)
    .get(coerce(entityId, primaryKey)) as { owner: string | null } | undefined;
  return row?.owner === userId;
}
