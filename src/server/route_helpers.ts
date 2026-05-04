/**
 * Shared route-level helpers.
 *
 * Leaf module — imports memory primitives and `./http.ts` only, never
 * `./routes.ts`. Keeps cycle-risk away from the central dispatcher when
 * other route files start using these helpers.
 */

import type { Database } from "bun:sqlite";
import type { User } from "../auth/users.ts";
import {
  getProject,
  validateProjectName,
  type Project,
} from "../memory/projects.ts";
import { errorMessage } from "../util/error.ts";
import { json } from "./http.ts";

export function canSeeProject(p: Project, user: User): boolean {
  if (p.visibility === "public") return true;
  if (user.role === "admin") return true;
  return p.createdBy === user.id;
}

export function canEditProject(p: Project, user: User): boolean {
  if (user.role === "admin") return true;
  return p.createdBy === user.id;
}

export type AccessMode = "view" | "edit";

export type ProjectAccessResult =
  | { ok: true; project: string; p: Project }
  | { ok: false; response: Response };

/**
 * Resolve and authorise an untrusted project name from a URL or request body.
 * Bundles `validateProjectName` (400) + `getProject` existence (404) +
 * `canSeeProject` / `canEditProject` (403) into one call.
 *
 * Trusted callers that already hold a `Project` row derived from another
 * entity (e.g. `card.project`, `doc.project`) get no real savings — they
 * should keep calling `canSeeProject` / `canEditProject` directly.
 */
export function requireProjectAccess(
  db: Database,
  user: User,
  rawProject: string,
  mode: AccessMode,
): ProjectAccessResult {
  let project: string;
  try {
    project = validateProjectName(rawProject);
  } catch (e) {
    return { ok: false, response: json({ error: errorMessage(e) }, 400) };
  }
  const p = getProject(db, project);
  if (!p)
    return { ok: false, response: json({ error: "project not found" }, 404) };
  const allowed =
    mode === "edit" ? canEditProject(p, user) : canSeeProject(p, user);
  if (!allowed)
    return { ok: false, response: json({ error: "forbidden" }, 403) };
  return { ok: true, project, p };
}
