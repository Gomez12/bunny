/**
 * HTTP routes for skills (`/api/skills*`, `/api/projects/:p/skills*`).
 * Called from {@link ./routes.ts} after agent routes.
 */

import type { Database } from "bun:sqlite";
import type { BunnyQueue } from "../queue/bunqueue.ts";
import type { User } from "../auth/users.ts";
import { errorMessage } from "../util/error.ts";
import { json } from "./http.ts";
import {
  createSkill,
  deleteSkill,
  getSkill,
  linkSkillToProject,
  listSkills,
  listSkillsForProject,
  listProjectsForSkill,
  mapProjectsBySkill,
  unlinkSkillFromProject,
  updateSkill,
  validateSkillName,
  type Skill,
  type SkillVisibility,
} from "../memory/skills.ts";
import {
  ensureSkillDir,
  loadSkillAssets,
  writeSkillMd,
  type SkillAssets,
} from "../memory/skill_assets.ts";
import {
  installSkillFromGitHub,
  installSkillFromSkillsSh,
} from "../memory/skill_install.ts";
import { getProject, validateProjectName } from "../memory/projects.ts";

export interface SkillRouteCtx {
  db: Database;
  queue: BunnyQueue;
  defaultProject: string;
}

export async function handleSkillRoute(
  req: Request,
  url: URL,
  ctx: SkillRouteCtx,
  user: User,
): Promise<Response | null> {
  const { pathname } = url;

  if (pathname === "/api/skills" && req.method === "GET") {
    const skills = listSkills(ctx.db).filter((s) => canSeeSkill(s, user));
    const projectMap = mapProjectsBySkill(ctx.db);
    return json({ skills: skills.map((s) => toSkillDto(s, projectMap.get(s.name) ?? [])) });
  }

  if (pathname === "/api/skills" && req.method === "POST") {
    return handleCreateSkill(req, ctx, user);
  }

  if (pathname === "/api/skills/install" && req.method === "POST") {
    return handleInstallSkill(req, ctx, user);
  }

  const skillMatch = pathname.match(/^\/api\/skills\/([^/]+)$/);
  if (skillMatch) {
    const name = decodeURIComponent(skillMatch[1]!);
    if (req.method === "GET") return handleGetSkill(ctx, user, name);
    if (req.method === "PATCH") return handlePatchSkill(req, ctx, user, name);
    if (req.method === "DELETE") return handleDeleteSkill(ctx, user, name);
  }

  const projectSkillsMatch = pathname.match(/^\/api\/projects\/([^/]+)\/skills$/);
  if (projectSkillsMatch) {
    const rawProject = decodeURIComponent(projectSkillsMatch[1]!);
    if (req.method === "GET") return handleListProjectSkills(ctx, user, rawProject);
    if (req.method === "POST") return handleLinkSkill(req, ctx, user, rawProject);
  }

  const linkMatch = pathname.match(/^\/api\/projects\/([^/]+)\/skills\/([^/]+)$/);
  if (linkMatch) {
    const rawProject = decodeURIComponent(linkMatch[1]!);
    const rawSkill = decodeURIComponent(linkMatch[2]!);
    if (req.method === "DELETE") return handleUnlinkSkill(ctx, user, rawProject, rawSkill);
  }

  return null;
}

// ── DTO ──────────────────────────────────────────────────────────────────

export interface SkillDto {
  name: string;
  description: string;
  visibility: SkillVisibility;
  sourceUrl: string | null;
  sourceRef: string | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
  skillMd: string;
  allowedTools: string[];
  projects: string[];
}

function toSkillDto(s: Skill, projects: readonly string[] = []): SkillDto {
  let assets: SkillAssets;
  try {
    assets = loadSkillAssets(s.name);
  } catch {
    assets = {
      frontmatter: { name: s.name, description: "" },
      instructions: "",
      raw: "",
    };
  }
  return {
    name: s.name,
    description: s.description || assets.frontmatter.description,
    visibility: s.visibility,
    sourceUrl: s.sourceUrl,
    sourceRef: s.sourceRef,
    createdBy: s.createdBy,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    skillMd: assets.raw,
    allowedTools: assets.frontmatter.allowedTools ?? [],
    projects: [...projects],
  };
}

function canSeeSkill(s: Skill, user: User): boolean {
  if (s.visibility === "public") return true;
  if (user.role === "admin") return true;
  return s.createdBy === user.id;
}

function canEditSkill(s: Skill, user: User): boolean {
  if (user.role === "admin") return true;
  return s.createdBy === user.id;
}

// ── Handlers ─────────────────────────────────────────────────────────────

interface SkillBody {
  name?: string;
  description?: string | null;
  visibility?: SkillVisibility;
  skillMd?: string;
}

async function handleCreateSkill(req: Request, ctx: SkillRouteCtx, user: User): Promise<Response> {
  let body: SkillBody;
  try {
    body = (await req.json()) as SkillBody;
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  try {
    const name = validateSkillName(body.name ?? "");
    if (getSkill(ctx.db, name)) return json({ error: `skill '${name}' already exists` }, 409);

    const skillMd = body.skillMd ?? `---\nname: ${name}\ndescription: ${body.description ?? ""}\n---\n`;
    ensureSkillDir(name, skillMd);

    const created = createSkill(ctx.db, {
      name,
      description: body.description ?? "",
      visibility: body.visibility === "public" ? "public" : "private",
      createdBy: user.id,
    });
    if (getProject(ctx.db, ctx.defaultProject)) {
      linkSkillToProject(ctx.db, ctx.defaultProject, name);
    }
    void ctx.queue.log({
      topic: "skill",
      kind: "create",
      userId: user.id,
      data: { name, visibility: body.visibility ?? "private" },
    });
    return json({ skill: toSkillDto(created, listProjectsForSkill(ctx.db, name)) }, 201);
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

async function handleInstallSkill(req: Request, ctx: SkillRouteCtx, user: User): Promise<Response> {
  let body: { url?: string; name?: string };
  try {
    body = (await req.json()) as { url?: string; name?: string };
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  const rawUrl = typeof body.url === "string" ? body.url.trim() : "";
  if (!rawUrl) return json({ error: "'url' is required" }, 400);
  try {
    const isSkillsSh = rawUrl.includes("skills.sh") || (!rawUrl.includes("github.com") && /^[a-z0-9_-]+\/[a-z0-9_-]+/i.test(rawUrl));
    const result = isSkillsSh
      ? await installSkillFromSkillsSh(rawUrl.replace(/^https?:\/\/skills\.sh\//, ""), body.name)
      : await installSkillFromGitHub(rawUrl, body.name);

    if (getSkill(ctx.db, result.name)) {
      updateSkill(ctx.db, result.name, {
        description: result.description,
        sourceUrl: result.sourceUrl,
        sourceRef: result.sourceRef,
      });
    } else {
      createSkill(ctx.db, {
        name: result.name,
        description: result.description,
        sourceUrl: result.sourceUrl,
        sourceRef: result.sourceRef,
        createdBy: user.id,
      });
    }
    if (getProject(ctx.db, ctx.defaultProject)) {
      linkSkillToProject(ctx.db, ctx.defaultProject, result.name);
    }
    void ctx.queue.log({
      topic: "skill",
      kind: "install",
      userId: user.id,
      data: { name: result.name, sourceUrl: result.sourceUrl },
    });
    const skill = getSkill(ctx.db, result.name)!;
    return json({ skill: toSkillDto(skill, listProjectsForSkill(ctx.db, result.name)) }, 201);
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

function handleGetSkill(ctx: SkillRouteCtx, user: User, name: string): Response {
  const s = getSkill(ctx.db, name);
  if (!s) return json({ error: "not found" }, 404);
  if (!canSeeSkill(s, user)) return json({ error: "forbidden" }, 403);
  return json({ skill: toSkillDto(s, listProjectsForSkill(ctx.db, s.name)) });
}

async function handlePatchSkill(
  req: Request,
  ctx: SkillRouteCtx,
  user: User,
  name: string,
): Promise<Response> {
  const existing = getSkill(ctx.db, name);
  if (!existing) return json({ error: "not found" }, 404);
  if (!canEditSkill(existing, user)) return json({ error: "forbidden" }, 403);
  let body: SkillBody;
  try {
    body = (await req.json()) as SkillBody;
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  try {
    const updated = updateSkill(ctx.db, name, {
      description: body.description ?? undefined,
      visibility: body.visibility,
    });
    if (body.skillMd !== undefined) {
      writeSkillMd(name, body.skillMd);
    }
    void ctx.queue.log({ topic: "skill", kind: "update", userId: user.id, data: { name } });
    return json({ skill: toSkillDto(updated, listProjectsForSkill(ctx.db, name)) });
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

function handleDeleteSkill(ctx: SkillRouteCtx, user: User, name: string): Response {
  const s = getSkill(ctx.db, name);
  if (!s) return json({ error: "not found" }, 404);
  if (!canEditSkill(s, user)) return json({ error: "forbidden" }, 403);
  try {
    deleteSkill(ctx.db, name);
    void ctx.queue.log({ topic: "skill", kind: "delete", userId: user.id, data: { name } });
    return json({ ok: true });
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

function handleListProjectSkills(ctx: SkillRouteCtx, user: User, rawProject: string): Response {
  let project: string;
  try {
    project = validateProjectName(rawProject);
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
  const p = getProject(ctx.db, project);
  if (!p) return json({ error: "project not found" }, 404);
  if (p.visibility === "private" && user.role !== "admin" && p.createdBy !== user.id) {
    return json({ error: "forbidden" }, 403);
  }
  const skills = listSkillsForProject(ctx.db, project).filter((s) => canSeeSkill(s, user));
  const projectMap = mapProjectsBySkill(ctx.db);
  return json({ skills: skills.map((s) => toSkillDto(s, projectMap.get(s.name) ?? [])) });
}

async function handleLinkSkill(
  req: Request,
  ctx: SkillRouteCtx,
  user: User,
  rawProject: string,
): Promise<Response> {
  let project: string;
  try {
    project = validateProjectName(rawProject);
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
  const p = getProject(ctx.db, project);
  if (!p) return json({ error: "project not found" }, 404);
  if (user.role !== "admin" && p.createdBy !== user.id) {
    return json({ error: "forbidden" }, 403);
  }
  let body: { skill?: string };
  try {
    body = (await req.json()) as { skill?: string };
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  try {
    const skill = validateSkillName(body.skill ?? "");
    if (!getSkill(ctx.db, skill)) return json({ error: "skill not found" }, 404);
    linkSkillToProject(ctx.db, project, skill);
    void ctx.queue.log({ topic: "skill", kind: "link", userId: user.id, data: { project, skill } });
    return json({ ok: true });
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

function handleUnlinkSkill(
  ctx: SkillRouteCtx,
  user: User,
  rawProject: string,
  rawSkill: string,
): Response {
  let project: string;
  let skill: string;
  try {
    project = validateProjectName(rawProject);
    skill = validateSkillName(rawSkill);
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
  const p = getProject(ctx.db, project);
  if (!p) return json({ error: "project not found" }, 404);
  if (user.role !== "admin" && p.createdBy !== user.id) {
    return json({ error: "forbidden" }, 403);
  }
  unlinkSkillFromProject(ctx.db, project, skill);
  void ctx.queue.log({ topic: "skill", kind: "unlink", userId: user.id, data: { project, skill } });
  return json({ ok: true });
}
