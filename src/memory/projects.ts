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
  languages: string[];
  defaultLanguage: string;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

const ISO_639_1_RE = /^[a-z]{2}$/;

/** Normalise + validate a languages/default_language pair. Throws on invalid input. */
export function validateLanguages(
  rawLanguages: unknown,
  rawDefault: unknown,
): { languages: string[]; defaultLanguage: string } {
  if (!Array.isArray(rawLanguages) || rawLanguages.length === 0) {
    throw new Error("languages must be a non-empty array of ISO 639-1 codes");
  }
  const languages: string[] = [];
  for (const l of rawLanguages) {
    if (typeof l !== "string") {
      throw new Error("languages must contain only strings");
    }
    const code = l.toLowerCase();
    if (!ISO_639_1_RE.test(code)) {
      throw new Error(`invalid language code '${l}' (ISO 639-1 expected)`);
    }
    if (!languages.includes(code)) languages.push(code);
  }
  if (typeof rawDefault !== "string") {
    throw new Error("default_language must be a string");
  }
  const def = rawDefault.toLowerCase();
  if (!ISO_639_1_RE.test(def)) {
    throw new Error(`invalid default_language '${rawDefault}'`);
  }
  if (!languages.includes(def)) {
    throw new Error(
      `default_language '${def}' must be listed in languages [${languages.join(", ")}]`,
    );
  }
  return { languages, defaultLanguage: def };
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
  languages: string | null;
  default_language: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

function parseLanguages(raw: string | null): string[] {
  if (!raw) return ["en"];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return ["en"];
    const out: string[] = [];
    for (const v of arr) {
      if (typeof v === "string" && ISO_639_1_RE.test(v)) out.push(v);
    }
    return out.length ? out : ["en"];
  } catch {
    return ["en"];
  }
}

function rowToProject(r: ProjectRow): Project {
  const languages = parseLanguages(r.languages);
  const def =
    r.default_language && ISO_639_1_RE.test(r.default_language)
      ? r.default_language
      : languages[0]!;
  return {
    name: r.name,
    description: r.description,
    visibility: (r.visibility === "private"
      ? "private"
      : "public") as ProjectVisibility,
    languages,
    defaultLanguage: languages.includes(def) ? def : languages[0]!,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const PROJECT_SELECT_COLS = `name, description, visibility, languages, default_language,
                              created_by, created_at, updated_at`;

export function listProjects(db: Database): Project[] {
  const rows = db
    .prepare(`SELECT ${PROJECT_SELECT_COLS} FROM projects ORDER BY name ASC`)
    .all() as ProjectRow[];
  return rows.map(rowToProject);
}

export function getProject(db: Database, name: string): Project | null {
  const row = db
    .prepare(`SELECT ${PROJECT_SELECT_COLS} FROM projects WHERE name = ?`)
    .get(name) as ProjectRow | undefined;
  return row ? rowToProject(row) : null;
}

export interface CreateProjectOpts {
  name: string;
  description?: string | null;
  visibility?: ProjectVisibility;
  languages?: string[];
  defaultLanguage?: string;
  createdBy?: string | null;
}

export function createProject(db: Database, opts: CreateProjectOpts): Project {
  const name = validateProjectName(opts.name);
  const now = Date.now();
  const rawLanguages = opts.languages ?? ["en"];
  const rawDefault = opts.defaultLanguage ?? rawLanguages[0] ?? "en";
  const { languages, defaultLanguage } = validateLanguages(
    rawLanguages,
    rawDefault,
  );
  db.prepare(
    `INSERT INTO projects(name, description, visibility, languages, default_language,
                          created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    name,
    opts.description ?? null,
    opts.visibility ?? "public",
    JSON.stringify(languages),
    defaultLanguage,
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
  languages?: string[];
  defaultLanguage?: string;
}

export function updateProject(
  db: Database,
  name: string,
  patch: UpdateProjectPatch,
): Project {
  const existing = getProject(db, name);
  if (!existing) throw new Error(`project '${name}' not found`);
  const description =
    patch.description === undefined ? existing.description : patch.description;
  const visibility = patch.visibility ?? existing.visibility;
  let languages = existing.languages;
  let defaultLanguage = existing.defaultLanguage;
  if (patch.languages !== undefined || patch.defaultLanguage !== undefined) {
    const nextLanguages = patch.languages ?? existing.languages;
    const nextDefault = patch.defaultLanguage ?? existing.defaultLanguage;
    const validated = validateLanguages(nextLanguages, nextDefault);
    languages = validated.languages;
    defaultLanguage = validated.defaultLanguage;
  }
  db.prepare(
    `UPDATE projects
       SET description = ?, visibility = ?, languages = ?, default_language = ?,
           updated_at = ?
     WHERE name = ?`,
  ).run(
    description,
    visibility,
    JSON.stringify(languages),
    defaultLanguage,
    Date.now(),
    name,
  );
  return getProject(db, name)!;
}

export function deleteProject(db: Database, name: string): void {
  if (name === DEFAULT_PROJECT)
    throw new Error(`cannot delete the default '${DEFAULT_PROJECT}' project`);
  db.prepare(`DELETE FROM projects WHERE name = ?`).run(name);
}

/**
 * Return the project a session is already bound to, or `null` when the session
 * has no messages yet. Legacy NULL `project` columns coalesce to
 * {@link DEFAULT_PROJECT}. Callers use `null` to decide whether to accept a
 * caller-supplied project vs. enforce the existing one.
 */
export function getSessionProject(
  db: Database,
  sessionId: string,
): string | null {
  const row = db
    .prepare(
      `SELECT COALESCE(project, ?) AS project FROM messages WHERE session_id = ? LIMIT 1`,
    )
    .get(DEFAULT_PROJECT, sessionId) as { project: string } | undefined;
  return row?.project ?? null;
}

/** Ensure a project row exists; create with defaults if missing. Returns the row. */
export function ensureProject(
  db: Database,
  name: string,
  createdBy?: string | null,
): Project {
  const validated = validateProjectName(name);
  const existing = getProject(db, validated);
  if (existing) return existing;
  return createProject(db, { name: validated, createdBy: createdBy ?? null });
}
