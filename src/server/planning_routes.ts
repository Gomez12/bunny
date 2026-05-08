/**
 * HTTP routes for the Planning module.
 *
 * Two prefix families:
 *   /api/projects/:project/planning            (parent-scoped)
 *   /api/planning/:id/...                      (planning-project id-scoped)
 *   /api/planning-{deadlines,teams,tags,wishes}/:id  (child id-scoped)
 *
 * The user is in lead — these routes never silently mutate user-approved
 * dates. The "Generate suggestion" / "Apply" / "Reject" endpoints write to
 * planning_suggestions; only Apply copies dates onto wishes (and at that
 * point fires notifications).
 */

import type { Database } from "bun:sqlite";
import type { BunnyConfig } from "../config.ts";
import type { BunnyQueue } from "../queue/bunqueue.ts";
import type { User } from "../auth/users.ts";

import { errorMessage } from "../util/error.ts";
import { json, readJson } from "./http.ts";
import { canEditProject, canSeeProject } from "./route_helpers.ts";
import { getProject, validateProjectName } from "../memory/projects.ts";
import { listUsers } from "../auth/users.ts";

import {
  canEditPlanningProject,
  createPlanningProject,
  deletePlanningProject,
  getPlanningProject,
  listPlanningProjects,
  updatePlanningProject,
  validatePlanningProjectName,
} from "../memory/planning_projects.ts";
import {
  createDeadline,
  deleteDeadline,
  getDeadline,
  listDeadlines,
  updateDeadline,
} from "../memory/planning_deadlines.ts";
import {
  addTeamMember,
  createTeam,
  deleteTeam,
  getTeam,
  listTeams,
  removeTeamMember,
  updateTeam,
} from "../memory/planning_teams.ts";
import {
  createTag,
  deleteTag,
  getTag,
  listTags,
  updateTag,
} from "../memory/planning_tags.ts";
import {
  applyPlacements,
  createWish,
  deleteWish,
  getWish,
  listWishes,
  setWishAdviceHide,
  updateWish,
} from "../memory/planning_wishes.ts";
import {
  acceptPending,
  getPendingSuggestion,
  rejectPending,
} from "../memory/planning_suggestions.ts";
import { buildAndStoreSuggestion } from "../planning/suggestion_refresh_handler.ts";
import {
  notifyDeadlineConflict,
  notifyTeamAssignment,
} from "../planning/notifications.ts";
import { computeSchedule, formatDate } from "../planning/scheduler.ts";
import {
  getLatestReport,
  getReport,
  listReports,
} from "../memory/planning_reports.ts";
import { buildAndStoreReport } from "../planning/report_snapshot_handler.ts";

export interface PlanningRouteCtx {
  db: Database;
  queue: BunnyQueue;
  cfg: BunnyConfig;
}

export async function handlePlanningRoute(
  req: Request,
  url: URL,
  ctx: PlanningRouteCtx,
  user: User,
): Promise<Response | null> {
  const { pathname } = url;
  const m = (re: RegExp) => pathname.match(re);

  // ── Parent-scoped (per Bunny project) ──────────────────────────────────
  let mm = m(/^\/api\/projects\/([^/]+)\/planning$/);
  if (mm) {
    const project = decodeURIComponent(mm[1]!);
    if (req.method === "GET") return listProjects(ctx, user, project);
    if (req.method === "POST") return createProject(req, ctx, user, project);
  }

  // ── Planning-project id-scoped ─────────────────────────────────────────
  mm = m(/^\/api\/planning\/(\d+)$/);
  if (mm) {
    const id = Number(mm[1]);
    if (req.method === "GET") return getOneProject(ctx, user, id);
    if (req.method === "PATCH") return patchProject(req, ctx, user, id);
    if (req.method === "DELETE") return deleteOneProject(ctx, user, id);
  }

  // Children: deadlines / teams / tags / wishes (list + create scoped to pp)
  mm = m(/^\/api\/planning\/(\d+)\/deadlines$/);
  if (mm) {
    const ppId = Number(mm[1]);
    if (req.method === "GET") return listChildren(ctx, user, ppId, "deadlines");
    if (req.method === "POST") return createDeadlineRoute(req, ctx, user, ppId);
  }
  mm = m(/^\/api\/planning\/(\d+)\/teams$/);
  if (mm) {
    const ppId = Number(mm[1]);
    if (req.method === "GET") return listChildren(ctx, user, ppId, "teams");
    if (req.method === "POST") return createTeamRoute(req, ctx, user, ppId);
  }
  mm = m(/^\/api\/planning\/(\d+)\/tags$/);
  if (mm) {
    const ppId = Number(mm[1]);
    if (req.method === "GET") return listChildren(ctx, user, ppId, "tags");
    if (req.method === "POST") return createTagRoute(req, ctx, user, ppId);
  }
  mm = m(/^\/api\/planning\/(\d+)\/wishes$/);
  if (mm) {
    const ppId = Number(mm[1]);
    if (req.method === "GET") return listChildren(ctx, user, ppId, "wishes");
    if (req.method === "POST") return createWishRoute(req, ctx, user, ppId);
  }

  // Suggestion + report
  mm = m(/^\/api\/planning\/(\d+)\/suggestion\/generate$/);
  if (mm && req.method === "POST")
    return generateSuggestionRoute(ctx, user, Number(mm[1]));

  mm = m(/^\/api\/planning\/(\d+)\/suggestion$/);
  if (mm && req.method === "GET")
    return getPendingSuggestionRoute(ctx, user, Number(mm[1]));

  mm = m(/^\/api\/planning\/(\d+)\/suggestion\/apply$/);
  if (mm && req.method === "POST")
    return applySuggestionRoute(req, ctx, user, Number(mm[1]));

  mm = m(/^\/api\/planning\/(\d+)\/suggestion\/reject$/);
  if (mm && req.method === "POST")
    return rejectSuggestionRoute(req, ctx, user, Number(mm[1]));

  mm = m(/^\/api\/planning\/(\d+)\/report$/);
  if (mm && req.method === "GET")
    return reportRoute(ctx, user, Number(mm[1]));

  // Executive report snapshots — manual generate, history list, fetch by id.
  mm = m(/^\/api\/planning\/(\d+)\/report\/generate$/);
  if (mm && req.method === "POST")
    return generateReportRoute(ctx, user, Number(mm[1]));

  mm = m(/^\/api\/planning\/(\d+)\/report\/latest$/);
  if (mm && req.method === "GET")
    return getLatestReportRoute(ctx, user, Number(mm[1]));

  mm = m(/^\/api\/planning\/(\d+)\/reports$/);
  if (mm && req.method === "GET")
    return listReportsRoute(ctx, user, Number(mm[1]));

  mm = m(/^\/api\/planning-reports\/(\d+)\/markdown$/);
  if (mm && req.method === "GET")
    return getReportMarkdownRoute(ctx, user, Number(mm[1]));

  mm = m(/^\/api\/planning-reports\/(\d+)$/);
  if (mm && req.method === "GET")
    return getReportRoute(ctx, user, Number(mm[1]));

  // Child id-scoped (deadline/team/tag/wish CRUD by id)
  mm = m(/^\/api\/planning-deadlines\/(\d+)$/);
  if (mm) {
    const id = Number(mm[1]);
    if (req.method === "PATCH") return patchDeadline(req, ctx, user, id);
    if (req.method === "DELETE") return deleteDeadlineRoute(ctx, user, id);
  }
  mm = m(/^\/api\/planning-teams\/(\d+)$/);
  if (mm) {
    const id = Number(mm[1]);
    if (req.method === "PATCH") return patchTeam(req, ctx, user, id);
    if (req.method === "DELETE") return deleteTeamRoute(ctx, user, id);
  }
  mm = m(/^\/api\/planning-teams\/(\d+)\/members$/);
  if (mm && req.method === "POST")
    return addTeamMemberRoute(req, ctx, user, Number(mm[1]));
  mm = m(/^\/api\/planning-teams\/(\d+)\/members\/([^/]+)$/);
  if (mm && req.method === "DELETE")
    return removeTeamMemberRoute(
      ctx,
      user,
      Number(mm[1]),
      decodeURIComponent(mm[2]!),
    );

  mm = m(/^\/api\/planning-tags\/(\d+)$/);
  if (mm) {
    const id = Number(mm[1]);
    if (req.method === "PATCH") return patchTag(req, ctx, user, id);
    if (req.method === "DELETE") return deleteTagRoute(ctx, user, id);
  }

  mm = m(/^\/api\/planning-wishes\/(\d+)$/);
  if (mm) {
    const id = Number(mm[1]);
    if (req.method === "PATCH") return patchWish(req, ctx, user, id);
    if (req.method === "DELETE") return deleteWishRoute(ctx, user, id);
  }

  mm = m(/^\/api\/planning-wishes\/(\d+)\/advice-hide$/);
  if (mm) {
    const id = Number(mm[1]);
    if (req.method === "POST") return setAdviceHideRoute(req, ctx, user, id);
    if (req.method === "DELETE") return clearAdviceHideRoute(ctx, user, id);
  }

  return null;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function loadProjectAndScope(
  ctx: PlanningRouteCtx,
  user: User,
  rawProject: string,
  mode: "see" | "edit",
): { ok: true; project: string } | { ok: false; resp: Response } {
  let project: string;
  try {
    project = validateProjectName(rawProject);
  } catch (e) {
    return { ok: false, resp: json({ error: errorMessage(e) }, 400) };
  }
  const p = getProject(ctx.db, project);
  if (!p) return { ok: false, resp: json({ error: "project not found" }, 404) };
  const allowed =
    mode === "edit" ? canEditProject(p, user) : canSeeProject(p, user);
  if (!allowed)
    return { ok: false, resp: json({ error: "forbidden" }, 403) };
  return { ok: true, project };
}

function loadPpAndScope(
  ctx: PlanningRouteCtx,
  user: User,
  ppId: number,
  mode: "see" | "edit",
):
  | {
      ok: true;
      pp: ReturnType<typeof getPlanningProject> & object;
      project: ReturnType<typeof getProject> & object;
    }
  | { ok: false; resp: Response } {
  const pp = getPlanningProject(ctx.db, ppId);
  if (!pp) return { ok: false, resp: json({ error: "not found" }, 404) };
  const project = getProject(ctx.db, pp.project);
  if (!project)
    return {
      ok: false,
      resp: json({ error: "project not found" }, 404),
    };
  if (mode === "see") {
    if (!canSeeProject(project, user))
      return { ok: false, resp: json({ error: "forbidden" }, 403) };
  } else {
    if (!canEditPlanningProject(user, pp, project))
      return { ok: false, resp: json({ error: "forbidden" }, 403) };
  }
  return { ok: true, pp, project };
}

// ── Planning project CRUD ──────────────────────────────────────────────────

function listProjects(
  ctx: PlanningRouteCtx,
  user: User,
  rawProject: string,
): Response {
  const r = loadProjectAndScope(ctx, user, rawProject, "see");
  if (!r.ok) return r.resp;
  return json({ planningProjects: listPlanningProjects(ctx.db, r.project) });
}

async function createProject(
  req: Request,
  ctx: PlanningRouteCtx,
  user: User,
  rawProject: string,
): Promise<Response> {
  const r = loadProjectAndScope(ctx, user, rawProject, "edit");
  if (!r.ok) return r.resp;
  const body = await readJson<{
    name?: string;
    description?: string;
    startDate?: string | null;
    sprintDurationDays?: number | null;
  }>(req);
  if (!body) return json({ error: "invalid json" }, 400);
  let name: string;
  try {
    name = validatePlanningProjectName(body.name);
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
  let created;
  try {
    created = createPlanningProject(ctx.db, {
      project: r.project,
      name,
      description: body.description?.trim() ?? "",
      startDate: body.startDate?.trim() || null,
      sprintDurationDays: body.sprintDurationDays ?? null,
      createdBy: user.id,
    });
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
  void ctx.queue.log({
    topic: "planning",
    kind: "project.create",
    userId: user.id,
    data: { id: created.id, project: r.project, name },
  });
  return json({ planningProject: created }, 201);
}

function getOneProject(
  ctx: PlanningRouteCtx,
  user: User,
  id: number,
): Response {
  const r = loadPpAndScope(ctx, user, id, "see");
  if (!r.ok) return r.resp;
  return json({ planningProject: r.pp });
}

async function patchProject(
  req: Request,
  ctx: PlanningRouteCtx,
  user: User,
  id: number,
): Promise<Response> {
  const r = loadPpAndScope(ctx, user, id, "edit");
  if (!r.ok) return r.resp;
  const body = await readJson<{
    description?: string;
    startDate?: string | null;
    sprintDurationDays?: number | null;
  }>(req);
  if (!body) return json({ error: "invalid json" }, 400);
  try {
    const updated = updatePlanningProject(ctx.db, id, {
      description: body.description,
      startDate:
        body.startDate === undefined
          ? undefined
          : body.startDate === null || body.startDate === ""
            ? null
            : body.startDate,
      sprintDurationDays:
        body.sprintDurationDays === undefined
          ? undefined
          : body.sprintDurationDays,
    });
    void ctx.queue.log({
      topic: "planning",
      kind: "project.update",
      userId: user.id,
      data: { id },
    });
    return json({ planningProject: updated });
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

function deleteOneProject(
  ctx: PlanningRouteCtx,
  user: User,
  id: number,
): Response {
  const r = loadPpAndScope(ctx, user, id, "edit");
  if (!r.ok) return r.resp;
  deletePlanningProject(ctx.db, id, user.id);
  void ctx.queue.log({
    topic: "planning",
    kind: "project.delete",
    userId: user.id,
    data: { id },
  });
  return json({ ok: true });
}

// ── Children list (one shared route) ───────────────────────────────────────

function listChildren(
  ctx: PlanningRouteCtx,
  user: User,
  ppId: number,
  kind: "deadlines" | "teams" | "tags" | "wishes",
): Response {
  const r = loadPpAndScope(ctx, user, ppId, "see");
  if (!r.ok) return r.resp;
  switch (kind) {
    case "deadlines":
      return json({ deadlines: listDeadlines(ctx.db, ppId) });
    case "teams":
      return json({ teams: listTeams(ctx.db, ppId) });
    case "tags":
      return json({ tags: listTags(ctx.db, ppId) });
    case "wishes":
      return json({ wishes: listWishes(ctx.db, ppId) });
  }
}

// ── Deadline CRUD ──────────────────────────────────────────────────────────

async function createDeadlineRoute(
  req: Request,
  ctx: PlanningRouteCtx,
  user: User,
  ppId: number,
): Promise<Response> {
  const r = loadPpAndScope(ctx, user, ppId, "edit");
  if (!r.ok) return r.resp;
  const body = await readJson<{
    name?: string;
    description?: string;
    dueDate?: string;
    color?: string | null;
  }>(req);
  if (!body || !body.name || !body.dueDate)
    return json({ error: "name and dueDate are required" }, 400);
  try {
    const dl = createDeadline(ctx.db, {
      planningProjectId: ppId,
      project: r.pp.project,
      name: body.name.trim(),
      description: body.description?.trim() ?? "",
      dueDate: body.dueDate,
      color: body.color ?? null,
      createdBy: user.id,
    });
    void ctx.queue.log({
      topic: "planning",
      kind: "deadline.create",
      userId: user.id,
      data: { id: dl.id, planningProjectId: ppId },
    });
    return json({ deadline: dl }, 201);
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

async function patchDeadline(
  req: Request,
  ctx: PlanningRouteCtx,
  user: User,
  id: number,
): Promise<Response> {
  const dl = getDeadline(ctx.db, id);
  if (!dl) return json({ error: "not found" }, 404);
  const r = loadPpAndScope(ctx, user, dl.planningProjectId, "edit");
  if (!r.ok) return r.resp;
  const body = await readJson<{
    name?: string;
    description?: string;
    dueDate?: string;
    color?: string | null;
  }>(req);
  if (!body) return json({ error: "invalid json" }, 400);
  try {
    const updated = updateDeadline(ctx.db, id, {
      name: body.name?.trim(),
      description: body.description?.trim(),
      dueDate: body.dueDate,
      color: body.color === undefined ? undefined : body.color,
    });
    void ctx.queue.log({
      topic: "planning",
      kind: "deadline.update",
      userId: user.id,
      data: { id },
    });
    return json({ deadline: updated });
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

function deleteDeadlineRoute(
  ctx: PlanningRouteCtx,
  user: User,
  id: number,
): Response {
  const dl = getDeadline(ctx.db, id);
  if (!dl) return json({ error: "not found" }, 404);
  const r = loadPpAndScope(ctx, user, dl.planningProjectId, "edit");
  if (!r.ok) return r.resp;
  deleteDeadline(ctx.db, id, user.id);
  void ctx.queue.log({
    topic: "planning",
    kind: "deadline.delete",
    userId: user.id,
    data: { id },
  });
  return json({ ok: true });
}

// ── Team CRUD + members ────────────────────────────────────────────────────

async function createTeamRoute(
  req: Request,
  ctx: PlanningRouteCtx,
  user: User,
  ppId: number,
): Promise<Response> {
  const r = loadPpAndScope(ctx, user, ppId, "edit");
  if (!r.ok) return r.resp;
  const body = await readJson<{
    name?: string;
    description?: string;
    color?: string | null;
    maxParallel?: number;
    members?: string[];
  }>(req);
  if (!body || !body.name)
    return json({ error: "name is required" }, 400);
  try {
    const team = createTeam(ctx.db, {
      planningProjectId: ppId,
      project: r.pp.project,
      name: body.name.trim(),
      description: body.description?.trim() ?? "",
      color: body.color ?? null,
      maxParallel: body.maxParallel,
      members: body.members,
      createdBy: user.id,
    });
    void ctx.queue.log({
      topic: "planning",
      kind: "team.create",
      userId: user.id,
      data: { id: team.id, planningProjectId: ppId },
    });
    return json({ team }, 201);
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

async function patchTeam(
  req: Request,
  ctx: PlanningRouteCtx,
  user: User,
  id: number,
): Promise<Response> {
  const team = getTeam(ctx.db, id);
  if (!team) return json({ error: "not found" }, 404);
  const r = loadPpAndScope(ctx, user, team.planningProjectId, "edit");
  if (!r.ok) return r.resp;
  const body = await readJson<{
    name?: string;
    description?: string;
    color?: string | null;
    maxParallel?: number;
  }>(req);
  if (!body) return json({ error: "invalid json" }, 400);
  try {
    const updated = updateTeam(ctx.db, id, {
      name: body.name?.trim(),
      description: body.description?.trim(),
      color: body.color === undefined ? undefined : body.color,
      maxParallel: body.maxParallel,
    });
    void ctx.queue.log({
      topic: "planning",
      kind: "team.update",
      userId: user.id,
      data: { id },
    });
    return json({ team: updated });
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

function deleteTeamRoute(
  ctx: PlanningRouteCtx,
  user: User,
  id: number,
): Response {
  const team = getTeam(ctx.db, id);
  if (!team) return json({ error: "not found" }, 404);
  const r = loadPpAndScope(ctx, user, team.planningProjectId, "edit");
  if (!r.ok) return r.resp;
  deleteTeam(ctx.db, id, user.id);
  void ctx.queue.log({
    topic: "planning",
    kind: "team.delete",
    userId: user.id,
    data: { id },
  });
  return json({ ok: true });
}

async function addTeamMemberRoute(
  req: Request,
  ctx: PlanningRouteCtx,
  user: User,
  id: number,
): Promise<Response> {
  const team = getTeam(ctx.db, id);
  if (!team) return json({ error: "not found" }, 404);
  const r = loadPpAndScope(ctx, user, team.planningProjectId, "edit");
  if (!r.ok) return r.resp;
  const body = await readJson<{ userId?: string }>(req);
  if (!body || !body.userId)
    return json({ error: "userId is required" }, 400);
  addTeamMember(ctx.db, id, body.userId);
  void ctx.queue.log({
    topic: "planning",
    kind: "team.member.add",
    userId: user.id,
    data: { teamId: id, addedUserId: body.userId },
  });
  return json({ team: getTeam(ctx.db, id)! });
}

function removeTeamMemberRoute(
  ctx: PlanningRouteCtx,
  user: User,
  id: number,
  removedUserId: string,
): Response {
  const team = getTeam(ctx.db, id);
  if (!team) return json({ error: "not found" }, 404);
  const r = loadPpAndScope(ctx, user, team.planningProjectId, "edit");
  if (!r.ok) return r.resp;
  removeTeamMember(ctx.db, id, removedUserId);
  void ctx.queue.log({
    topic: "planning",
    kind: "team.member.remove",
    userId: user.id,
    data: { teamId: id, removedUserId },
  });
  return json({ team: getTeam(ctx.db, id)! });
}

// ── Tag CRUD ───────────────────────────────────────────────────────────────

async function createTagRoute(
  req: Request,
  ctx: PlanningRouteCtx,
  user: User,
  ppId: number,
): Promise<Response> {
  const r = loadPpAndScope(ctx, user, ppId, "edit");
  if (!r.ok) return r.resp;
  const body = await readJson<{
    name?: string;
    description?: string;
    color?: string | null;
  }>(req);
  if (!body || !body.name)
    return json({ error: "name is required" }, 400);
  try {
    const tag = createTag(ctx.db, {
      planningProjectId: ppId,
      project: r.pp.project,
      name: body.name.trim(),
      description: body.description?.trim() ?? "",
      color: body.color ?? null,
      createdBy: user.id,
    });
    void ctx.queue.log({
      topic: "planning",
      kind: "tag.create",
      userId: user.id,
      data: { id: tag.id, planningProjectId: ppId },
    });
    return json({ tag }, 201);
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

async function patchTag(
  req: Request,
  ctx: PlanningRouteCtx,
  user: User,
  id: number,
): Promise<Response> {
  const tag = getTag(ctx.db, id);
  if (!tag) return json({ error: "not found" }, 404);
  const r = loadPpAndScope(ctx, user, tag.planningProjectId, "edit");
  if (!r.ok) return r.resp;
  const body = await readJson<{
    name?: string;
    description?: string;
    color?: string | null;
  }>(req);
  if (!body) return json({ error: "invalid json" }, 400);
  try {
    const updated = updateTag(ctx.db, id, {
      name: body.name?.trim(),
      description: body.description?.trim(),
      color: body.color === undefined ? undefined : body.color,
    });
    void ctx.queue.log({
      topic: "planning",
      kind: "tag.update",
      userId: user.id,
      data: { id },
    });
    return json({ tag: updated });
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

function deleteTagRoute(
  ctx: PlanningRouteCtx,
  user: User,
  id: number,
): Response {
  const tag = getTag(ctx.db, id);
  if (!tag) return json({ error: "not found" }, 404);
  const r = loadPpAndScope(ctx, user, tag.planningProjectId, "edit");
  if (!r.ok) return r.resp;
  deleteTag(ctx.db, id, user.id);
  void ctx.queue.log({
    topic: "planning",
    kind: "tag.delete",
    userId: user.id,
    data: { id },
  });
  return json({ ok: true });
}

// ── Wish CRUD ──────────────────────────────────────────────────────────────

async function createWishRoute(
  req: Request,
  ctx: PlanningRouteCtx,
  user: User,
  ppId: number,
): Promise<Response> {
  const r = loadPpAndScope(ctx, user, ppId, "edit");
  if (!r.ok) return r.resp;
  const body = await readJson<{
    title?: string;
    description?: string;
    durationDays?: number;
    teamId?: number | null;
    deadlineId?: number | null;
    plannedStartDate?: string | null;
    plannedEndDate?: string | null;
    status?: "planned" | "in_progress" | "done";
    dependsOnWishes?: number[];
    dependsOnTags?: string[];
    tagIds?: number[];
    jiraKey?: string | null;
  }>(req);
  if (!body || !body.title)
    return json({ error: "title is required" }, 400);
  try {
    const wish = createWish(ctx.db, {
      planningProjectId: ppId,
      project: r.pp.project,
      title: body.title.trim(),
      description: body.description?.trim() ?? "",
      durationDays: body.durationDays,
      teamId: body.teamId ?? null,
      deadlineId: body.deadlineId ?? null,
      plannedStartDate: body.plannedStartDate ?? null,
      plannedEndDate: body.plannedEndDate ?? null,
      status: body.status,
      dependsOnWishes: body.dependsOnWishes,
      dependsOnTags: body.dependsOnTags,
      tagIds: body.tagIds,
      jiraKey: body.jiraKey ?? null,
      createdBy: user.id,
    });
    void ctx.queue.log({
      topic: "planning",
      kind: "wish.create",
      userId: user.id,
      data: { id: wish.id, planningProjectId: ppId, teamId: wish.teamId },
    });
    if (wish.teamId !== null) {
      const team = getTeam(ctx.db, wish.teamId);
      if (team) {
        notifyTeamAssignment({
          db: ctx.db,
          queue: ctx.queue,
          project: r.pp.project,
          planningProjectId: ppId,
          wishId: wish.id,
          wishTitle: wish.title,
          newTeamId: team.id,
          newTeamName: team.name,
          actorUserId: user.id,
        });
      }
    }
    maybeFireDeadlineConflict(ctx, user, r.pp.project, ppId, wish.id);
    return json({ wish }, 201);
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

async function patchWish(
  req: Request,
  ctx: PlanningRouteCtx,
  user: User,
  id: number,
): Promise<Response> {
  const existing = getWish(ctx.db, id);
  if (!existing) return json({ error: "not found" }, 404);
  const r = loadPpAndScope(ctx, user, existing.planningProjectId, "edit");
  if (!r.ok) return r.resp;
  const body = await readJson<{
    title?: string;
    description?: string;
    durationDays?: number;
    teamId?: number | null;
    deadlineId?: number | null;
    plannedStartDate?: string | null;
    plannedEndDate?: string | null;
    status?: "planned" | "in_progress" | "done";
    dependsOnWishes?: number[];
    dependsOnTags?: string[];
    tagIds?: number[];
    jiraKey?: string | null;
  }>(req);
  if (!body) return json({ error: "invalid json" }, 400);
  const previousTeamId = existing.teamId;
  try {
    const updated = updateWish(ctx.db, id, {
      title: body.title?.trim(),
      description: body.description?.trim(),
      durationDays: body.durationDays,
      teamId: body.teamId === undefined ? undefined : body.teamId,
      deadlineId:
        body.deadlineId === undefined ? undefined : body.deadlineId,
      plannedStartDate:
        body.plannedStartDate === undefined ? undefined : body.plannedStartDate,
      plannedEndDate:
        body.plannedEndDate === undefined ? undefined : body.plannedEndDate,
      status: body.status,
      dependsOnWishes: body.dependsOnWishes,
      dependsOnTags: body.dependsOnTags,
      tagIds: body.tagIds,
      jiraKey: body.jiraKey === undefined ? undefined : body.jiraKey,
    });
    void ctx.queue.log({
      topic: "planning",
      kind: "wish.update",
      userId: user.id,
      data: { id, teamId: updated.teamId },
    });
    if (
      updated.teamId !== null &&
      updated.teamId !== previousTeamId
    ) {
      const team = getTeam(ctx.db, updated.teamId);
      if (team) {
        notifyTeamAssignment({
          db: ctx.db,
          queue: ctx.queue,
          project: r.pp.project,
          planningProjectId: existing.planningProjectId,
          wishId: updated.id,
          wishTitle: updated.title,
          newTeamId: team.id,
          newTeamName: team.name,
          actorUserId: user.id,
        });
      }
    }
    maybeFireDeadlineConflict(
      ctx,
      user,
      r.pp.project,
      existing.planningProjectId,
      updated.id,
    );
    return json({ wish: updated });
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

function deleteWishRoute(
  ctx: PlanningRouteCtx,
  user: User,
  id: number,
): Response {
  const wish = getWish(ctx.db, id);
  if (!wish) return json({ error: "not found" }, 404);
  const r = loadPpAndScope(ctx, user, wish.planningProjectId, "edit");
  if (!r.ok) return r.resp;
  deleteWish(ctx.db, id, user.id);
  void ctx.queue.log({
    topic: "planning",
    kind: "wish.delete",
    userId: user.id,
    data: { id },
  });
  return json({ ok: true });
}

// ── Suggestion + report ────────────────────────────────────────────────────

function generateSuggestionRoute(
  ctx: PlanningRouteCtx,
  user: User,
  ppId: number,
): Response {
  const r = loadPpAndScope(ctx, user, ppId, "edit");
  if (!r.ok) return r.resp;
  try {
    buildAndStoreSuggestion(ctx.db, ppId, user.id);
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
  void ctx.queue.log({
    topic: "planning",
    kind: "suggestion.generate",
    userId: user.id,
    data: { planningProjectId: ppId },
  });
  return json({ suggestion: getPendingSuggestion(ctx.db, ppId) });
}

function getPendingSuggestionRoute(
  ctx: PlanningRouteCtx,
  user: User,
  ppId: number,
): Response {
  const r = loadPpAndScope(ctx, user, ppId, "see");
  if (!r.ok) return r.resp;
  const pending = getPendingSuggestion(ctx.db, ppId);
  if (!pending) return json({ suggestion: null });
  return json({ suggestion: enrichSuggestion(ctx.db, pending) });
}

/**
 * Split the pending suggestion's placements into `placements` (visible) and
 * `hiddenPlacements` (matching the wish's advice-hide tuple). The hide
 * matches when the proposed (start, end) and the wish's current team match
 * the stored hide tuple. If any of those changes (different proposed dates,
 * or user moved the wish to another team), the hide auto-expires and the
 * placement reappears in the visible list.
 *
 * Reads only the four columns we need — full wish rows + tag joins would
 * be wasted work on `GET /suggestion`.
 */
function enrichSuggestion(
  db: Database,
  suggestion: NonNullable<ReturnType<typeof getPendingSuggestion>>,
): typeof suggestion & {
  payload: typeof suggestion.payload & {
    hiddenPlacements?: typeof suggestion.payload.placements;
  };
} {
  type HideRow = {
    id: number;
    team_id: number | null;
    advice_hide_start: string | null;
    advice_hide_end: string | null;
    advice_hide_team_id: number | null;
  };
  const rows = db
    .prepare(
      `SELECT id, team_id, advice_hide_start, advice_hide_end,
              advice_hide_team_id
         FROM planning_wishes
        WHERE planning_project_id = ? AND deleted_at IS NULL`,
    )
    .all(suggestion.planningProjectId) as HideRow[];
  const hideByWish = new Map(rows.map((r) => [r.id, r]));
  const visible: typeof suggestion.payload.placements = [];
  const hidden: typeof suggestion.payload.placements = [];
  for (const p of suggestion.payload.placements) {
    const r = hideByWish.get(p.wishId);
    const matches =
      r &&
      r.advice_hide_start === p.start &&
      r.advice_hide_end === p.end &&
      r.advice_hide_team_id === r.team_id;
    if (matches) hidden.push(p);
    else visible.push(p);
  }
  return {
    ...suggestion,
    payload: {
      ...suggestion.payload,
      placements: visible,
      hiddenPlacements: hidden,
    },
  };
}

async function setAdviceHideRoute(
  req: Request,
  ctx: PlanningRouteCtx,
  user: User,
  id: number,
): Promise<Response> {
  const wish = getWish(ctx.db, id);
  if (!wish) return json({ error: "not found" }, 404);
  const r = loadPpAndScope(ctx, user, wish.planningProjectId, "edit");
  if (!r.ok) return r.resp;
  const body = await readJson<{
    start?: string;
    end?: string;
    teamId?: number | null;
  }>(req);
  if (!body || !body.start || !body.end)
    return json({ error: "start and end are required" }, 400);
  try {
    setWishAdviceHide(ctx.db, id, {
      start: body.start,
      end: body.end,
      teamId: body.teamId === undefined ? wish.teamId : body.teamId,
    });
    void ctx.queue.log({
      topic: "planning",
      kind: "wish.advice_hide",
      userId: user.id,
      data: { id, start: body.start, end: body.end },
    });
    return json({ wish: getWish(ctx.db, id) });
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

function clearAdviceHideRoute(
  ctx: PlanningRouteCtx,
  user: User,
  id: number,
): Response {
  const wish = getWish(ctx.db, id);
  if (!wish) return json({ error: "not found" }, 404);
  const r = loadPpAndScope(ctx, user, wish.planningProjectId, "edit");
  if (!r.ok) return r.resp;
  setWishAdviceHide(ctx.db, id, null);
  void ctx.queue.log({
    topic: "planning",
    kind: "wish.advice_hide.clear",
    userId: user.id,
    data: { id },
  });
  return json({ wish: getWish(ctx.db, id) });
}

async function applySuggestionRoute(
  req: Request,
  ctx: PlanningRouteCtx,
  user: User,
  ppId: number,
): Promise<Response> {
  const r = loadPpAndScope(ctx, user, ppId, "edit");
  if (!r.ok) return r.resp;
  const body = await readJson<{ comment?: string }>(req);
  const pending = getPendingSuggestion(ctx.db, ppId);
  if (!pending) return json({ error: "no pending suggestion" }, 404);
  // 1. Snapshot per-wish team_id BEFORE we apply (to detect assignment changes).
  const wishesBefore = listWishes(ctx.db, ppId);
  const teamBefore = new Map<number, number | null>();
  for (const w of wishesBefore) teamBefore.set(w.id, w.teamId);
  // 2. Copy placement dates → wishes.
  applyPlacements(ctx.db, pending.payload.placements);
  // 3. Mark suggestion accepted.
  acceptPending(ctx.db, ppId, user.id, body?.comment ?? "");
  void ctx.queue.log({
    topic: "planning",
    kind: "suggestion.apply",
    userId: user.id,
    data: { planningProjectId: ppId, suggestionId: pending.id },
  });
  // 4. Fire deadline-conflict notifications for any wish whose new end-date
  //    crosses its deadline. Reuse the helper which dedupes itself.
  for (const placement of pending.payload.placements) {
    maybeFireDeadlineConflict(
      ctx,
      user,
      r.pp.project,
      ppId,
      placement.wishId,
    );
  }
  return json({ suggestion: pending, ok: true });
}

async function rejectSuggestionRoute(
  req: Request,
  ctx: PlanningRouteCtx,
  user: User,
  ppId: number,
): Promise<Response> {
  const r = loadPpAndScope(ctx, user, ppId, "edit");
  if (!r.ok) return r.resp;
  const body = await readJson<{ comment?: string }>(req);
  const result = rejectPending(ctx.db, ppId, user.id, body?.comment ?? "");
  if (!result) return json({ error: "no pending suggestion" }, 404);
  void ctx.queue.log({
    topic: "planning",
    kind: "suggestion.reject",
    userId: user.id,
    data: { planningProjectId: ppId, suggestionId: result.id },
  });
  return json({ suggestion: result, ok: true });
}

/**
 * Recompute bottlenecks against the *current* user-approved planned dates
 * (not the suggestion). Pure read; no writes.
 */
function reportRoute(
  ctx: PlanningRouteCtx,
  user: User,
  ppId: number,
): Response {
  const r = loadPpAndScope(ctx, user, ppId, "see");
  if (!r.ok) return r.resp;
  const wishes = listWishes(ctx.db, ppId);
  const teams = listTeams(ctx.db, ppId);
  const deadlines = listDeadlines(ctx.db, ppId);
  const tags = listTags(ctx.db, ppId);
  // Run the scheduler with manualStartDate set to wish.plannedStartDate so
  // user-approved placements are honoured. When a wish has no planned dates,
  // it's planned freely.
  const startDate = r.pp.startDate ?? formatDate(new Date());
  const out = computeSchedule({
    startDate,
    wishes: wishes.map((w) => ({
      id: w.id,
      durationDays: w.durationDays,
      teamId: w.teamId,
      deadlineId: w.deadlineId,
      dependsOnWishes: w.dependsOnWishes,
      dependsOnTags: w.dependsOnTags,
      tagIds: w.tagIds,
      manualStartDate: w.plannedStartDate,
    })),
    teams: teams.map((t) => ({ id: t.id, maxParallel: t.maxParallel })),
    deadlines: deadlines.map((d) => ({ id: d.id, dueDate: d.dueDate })),
    tags: tags.map((t) => ({ id: t.id, name: t.name })),
  });
  return json({
    bottlenecks: out.bottlenecks,
    placements: out.placements,
  });
}

// ── Executive report snapshots ─────────────────────────────────────────────

function generateReportRoute(
  ctx: PlanningRouteCtx,
  user: User,
  ppId: number,
): Response {
  const r = loadPpAndScope(ctx, user, ppId, "edit");
  if (!r.ok) return r.resp;
  try {
    const result = buildAndStoreReport(
      ctx.db,
      ppId,
      "manual",
      user.id,
      ctx.cfg.planning.maxReportsPerProject,
      user.displayName ?? user.username,
    );
    if (!result) return json({ error: "planning project not found" }, 404);
    void ctx.queue.log({
      topic: "planning",
      kind: "report.generate",
      userId: user.id,
      data: { planningProjectId: ppId, reportId: result.reportId },
    });
    const report = getReport(ctx.db, result.reportId);
    return json({ report }, 201);
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

function getLatestReportRoute(
  ctx: PlanningRouteCtx,
  user: User,
  ppId: number,
): Response {
  const r = loadPpAndScope(ctx, user, ppId, "see");
  if (!r.ok) return r.resp;
  return json({ report: getLatestReport(ctx.db, ppId) });
}

function listReportsRoute(
  ctx: PlanningRouteCtx,
  user: User,
  ppId: number,
): Response {
  const r = loadPpAndScope(ctx, user, ppId, "see");
  if (!r.ok) return r.resp;
  return json({
    reports: listReports(
      ctx.db,
      ppId,
      ctx.cfg.planning.maxReportsPerProject,
    ),
  });
}

function getReportRoute(
  ctx: PlanningRouteCtx,
  user: User,
  id: number,
): Response {
  const report = getReport(ctx.db, id);
  if (!report) return json({ error: "not found" }, 404);
  const r = loadPpAndScope(ctx, user, report.planningProjectId, "see");
  if (!r.ok) return r.resp;
  return json({ report });
}

function getReportMarkdownRoute(
  ctx: PlanningRouteCtx,
  user: User,
  id: number,
): Response {
  const report = getReport(ctx.db, id);
  if (!report) return json({ error: "not found" }, 404);
  const r = loadPpAndScope(ctx, user, report.planningProjectId, "see");
  if (!r.ok) return r.resp;
  const dateStamp = new Date(report.generatedAt)
    .toISOString()
    .replace(/[:.]/g, "-");
  const filename = `roadmap-report-${r.pp.name}-${dateStamp}.md`;
  return new Response(report.markdown, {
    status: 200,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

// ── Internal: deadline-conflict trigger ────────────────────────────────────

function maybeFireDeadlineConflict(
  ctx: PlanningRouteCtx,
  user: User,
  project: string,
  ppId: number,
  wishId: number,
): void {
  const wish = getWish(ctx.db, wishId);
  if (!wish || !wish.deadlineId || !wish.plannedEndDate) return;
  const dl = getDeadline(ctx.db, wish.deadlineId);
  if (!dl) return;
  if (wish.plannedEndDate <= dl.dueDate) return;
  const adminIds = listUsers(ctx.db, { limit: 200 })
    .filter((u) => u.role === "admin")
    .map((u) => u.id);
  notifyDeadlineConflict({
    db: ctx.db,
    queue: ctx.queue,
    project,
    planningProjectId: ppId,
    wishId: wish.id,
    wishTitle: wish.title,
    teamId: wish.teamId,
    deadlineName: dl.name,
    deadlineDueDate: dl.dueDate,
    plannedEndDate: wish.plannedEndDate,
    actorUserId: user.id,
    dedupWindowMs: ctx.cfg.planning.notifyDeadlineConflictDedupMs,
    adminUserIds: adminIds,
  });
}
