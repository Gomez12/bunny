/**
 * Skill registry — CRUD over the `skills` table and the `project_skills`
 * opt-in join table.
 *
 * A skill is a directory containing a SKILL.md file (agentskills.io standard).
 * The DB row stores metadata + provenance; `skill_assets.ts` owns on-disk
 * parsing. Availability inside a project is opt-in via {@link linkSkillToProject}.
 */

import type { Database } from "bun:sqlite";
import { SKILL_NAME_RE } from "./skill_name.ts";
import { validateSlugName } from "./slug.ts";

export type SkillVisibility = "public" | "private";

export interface Skill {
  name: string;
  description: string;
  visibility: SkillVisibility;
  sourceUrl: string | null;
  sourceRef: string | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

export { SKILL_NAME_RE };

export function validateSkillName(raw: unknown): string {
  return validateSlugName(raw, SKILL_NAME_RE, "skill");
}

interface SkillRow {
  name: string;
  description: string;
  visibility: string;
  source_url: string | null;
  source_ref: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

function rowToSkill(r: SkillRow): Skill {
  return {
    name: r.name,
    description: r.description ?? "",
    visibility: r.visibility === "public" ? "public" : "private",
    sourceUrl: r.source_url,
    sourceRef: r.source_ref,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const SELECT_COLUMNS = `name, description, visibility, source_url, source_ref,
                        created_by, created_at, updated_at`;

export function listSkills(db: Database): Skill[] {
  const rows = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM skills ORDER BY name ASC`)
    .all() as SkillRow[];
  return rows.map(rowToSkill);
}

export function getSkill(db: Database, name: string): Skill | null {
  const row = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM skills WHERE name = ?`)
    .get(name) as SkillRow | undefined;
  return row ? rowToSkill(row) : null;
}

export interface CreateSkillOpts {
  name: string;
  description?: string | null;
  visibility?: SkillVisibility;
  sourceUrl?: string | null;
  sourceRef?: string | null;
  createdBy?: string | null;
}

export function createSkill(db: Database, opts: CreateSkillOpts): Skill {
  const name = validateSkillName(opts.name);
  const now = Date.now();
  db.prepare(
    `INSERT INTO skills(name, description, visibility, source_url, source_ref,
                        created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    name,
    opts.description ?? "",
    opts.visibility ?? "private",
    opts.sourceUrl ?? null,
    opts.sourceRef ?? null,
    opts.createdBy ?? null,
    now,
    now,
  );
  return getSkill(db, name)!;
}

export interface UpdateSkillPatch {
  description?: string | null;
  visibility?: SkillVisibility;
  sourceUrl?: string | null;
  sourceRef?: string | null;
}

export function updateSkill(db: Database, name: string, patch: UpdateSkillPatch): Skill {
  const existing = getSkill(db, name);
  if (!existing) throw new Error(`skill '${name}' not found`);
  const description = patch.description === undefined ? existing.description : (patch.description ?? "");
  const visibility = patch.visibility ?? existing.visibility;
  const sourceUrl = patch.sourceUrl === undefined ? existing.sourceUrl : (patch.sourceUrl ?? null);
  const sourceRef = patch.sourceRef === undefined ? existing.sourceRef : (patch.sourceRef ?? null);
  db.prepare(
    `UPDATE skills
     SET description = ?, visibility = ?, source_url = ?, source_ref = ?, updated_at = ?
     WHERE name = ?`,
  ).run(description, visibility, sourceUrl, sourceRef, Date.now(), name);
  return getSkill(db, name)!;
}

export function deleteSkill(db: Database, name: string): void {
  db.prepare(`DELETE FROM project_skills WHERE skill = ?`).run(name);
  db.prepare(`DELETE FROM skills WHERE name = ?`).run(name);
}

// ── Project ↔ Skill links ────────────────────────────────────────────────

export function linkSkillToProject(db: Database, project: string, skill: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO project_skills(project, skill) VALUES (?, ?)`,
  ).run(project, skill);
}

export function unlinkSkillFromProject(db: Database, project: string, skill: string): void {
  db.prepare(`DELETE FROM project_skills WHERE project = ? AND skill = ?`).run(project, skill);
}

export function listSkillsForProject(db: Database, project: string): Skill[] {
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLUMNS.split(",").map((c) => "s." + c.trim()).join(", ")}
       FROM project_skills ps
       JOIN skills s ON s.name = ps.skill
       WHERE ps.project = ?
       ORDER BY s.name ASC`,
    )
    .all(project) as SkillRow[];
  return rows.map(rowToSkill);
}

export function listProjectsForSkill(db: Database, skill: string): string[] {
  const rows = db
    .prepare(`SELECT project FROM project_skills WHERE skill = ? ORDER BY project ASC`)
    .all(skill) as Array<{ project: string }>;
  return rows.map((r) => r.project);
}

export function mapProjectsBySkill(db: Database): Map<string, string[]> {
  const rows = db
    .prepare(`SELECT skill, project FROM project_skills ORDER BY skill ASC, project ASC`)
    .all() as Array<{ skill: string; project: string }>;
  const out = new Map<string, string[]>();
  for (const { skill, project } of rows) {
    const list = out.get(skill);
    if (list) list.push(project);
    else out.set(skill, [project]);
  }
  return out;
}

export function isSkillLinkedToProject(db: Database, project: string, skill: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS ok FROM project_skills WHERE project = ? AND skill = ? LIMIT 1`)
    .get(project, skill) as { ok: number } | undefined;
  return !!row;
}
