/**
 * HTTP routes for the Calendar Exceptions subsystem.
 *
 * Five route families (one per scope):
 *   GET/POST /api/calendar/global               admin-managed global exceptions
 *   POST      /api/calendar/global/holidays      SSE: agent fetches national holidays
 *   GET/POST  /api/projects/:p/calendar          project-level exceptions
 *   GET/POST  /api/planning/:id/calendar         planning-project exceptions
 *   GET/POST  /api/planning-teams/:id/calendar   team exceptions
 *   GET/POST  /api/users/me/calendar             personal user exceptions
 *   PATCH/DELETE /<scope>/<id>                   shared update/delete
 *   GET /api/calendar/working-days               resolver endpoint
 *
 * See docs/adr/0044-calendar-exceptions.md.
 */

import type { Database } from "bun:sqlite";
import type { BunnyConfig } from "../config.ts";
import type { BunnyQueue } from "../queue/bunqueue.ts";
import type { User } from "../auth/users.ts";

import { errorMessage } from "../util/error.ts";
import { json, readJson } from "./http.ts";
import { canEditProject, canSeeProject } from "./route_helpers.ts";
import { getProject } from "../memory/projects.ts";
import { getPlanningProject, canEditPlanningProject } from "../memory/planning_projects.ts";
import { getTeam } from "../memory/planning_teams.ts";
import {
  bulkInsertHolidays,
  bulkInsertWeekends,
  buildNonWorkingDateSet,
  createGlobalException,
  createPlanningException,
  createProjectException,
  createTeamException,
  createUserException,
  deleteException,
  getException,
  listGlobalExceptions,
  listPlanningExceptions,
  listProjectExceptions,
  listTeamExceptions,
  listUserExceptions,
  resolveWorkingDay,
  updateException,
  type ExceptionKind,
  type ExceptionScope,
} from "../memory/calendar.ts";
import { runAgent } from "../agent/loop.ts";
import {
  createSseRenderer,
  controllerSink,
  finishSse,
} from "../agent/render_sse.ts";
import { registry as toolsRegistry } from "../tools/index.ts";
import { renderPrompt } from "../prompts/resolve.ts";
import { setSessionHiddenFromChat } from "../memory/session_visibility.ts";

const SSE_ENCODER = new TextEncoder();

export interface CalendarRouteCtx {
  db: Database;
  queue: BunnyQueue;
  cfg: BunnyConfig;
}

export async function handleCalendarRoute(
  req: Request,
  url: URL,
  ctx: CalendarRouteCtx,
  user: User,
): Promise<Response | null> {
  const { pathname } = url;
  const m = (re: RegExp) => pathname.match(re);

  // ── Working-days resolver ─────────────────────────────────────────────────
  if (pathname === "/api/calendar/working-days" && req.method === "GET") {
    const date = url.searchParams.get("date");
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return json({ error: "date is required (YYYY-MM-DD)" }, 400);
    }
    const result = resolveWorkingDay(ctx.db, date, {
      projectName: url.searchParams.get("project"),
      planningProjectId: url.searchParams.has("planningId")
        ? Number(url.searchParams.get("planningId"))
        : null,
      planningTeamId: url.searchParams.has("teamId")
        ? Number(url.searchParams.get("teamId"))
        : null,
      userId: url.searchParams.get("userId"),
    });
    return json(result);
  }

  // ── Global: mark all weekends for a year ──────────────────────────────────
  if (pathname === "/api/calendar/global/weekends" && req.method === "POST") {
    if (user.role !== "admin") return json({ error: "forbidden" }, 403);
    const body = await readJson<{ year?: number }>(req);
    if (!body?.year || !Number.isInteger(body.year) || body.year < 1970 || body.year > 2100) {
      return json({ error: "year is required and must be between 1970 and 2100" }, 400);
    }
    const count = bulkInsertWeekends(ctx.db, body.year, user.id);
    void ctx.queue.log({
      topic: "calendar",
      kind: "weekends.insert",
      userId: user.id,
      data: { year: body.year, count },
    });
    return json({ count }, 201);
  }

  // ── Global: holiday fetch (SSE) ────────────────────────────────────────────
  if (pathname === "/api/calendar/global/holidays" && req.method === "POST") {
    if (user.role !== "admin") return json({ error: "forbidden" }, 403);
    const body = await readJson<{ countryCode?: string; year?: number }>(req);
    if (!body?.countryCode || !body.year) {
      return json({ error: "countryCode and year are required" }, 400);
    }
    const { countryCode, year } = body;
    if (!/^[A-Z]{2}$/.test(countryCode)) {
      return json({ error: "countryCode must be ISO 3166-1 alpha-2 (e.g. NL)" }, 400);
    }
    if (!Number.isInteger(year) || year < 1970 || year > 2100) {
      return json({ error: "year out of range" }, 400);
    }
    return handleHolidayFetch(ctx, user, countryCode, year);
  }

  // ── Global: list + create ─────────────────────────────────────────────────
  if (pathname === "/api/calendar/global") {
    if (req.method === "GET") {
      return json(listGlobalExceptions(ctx.db));
    }
    if (req.method === "POST") {
      if (user.role !== "admin") return json({ error: "forbidden" }, 403);
      return handleCreateGlobal(req, ctx, user);
    }
  }

  // ── Global: patch + delete ─────────────────────────────────────────────────
  let mm = m(/^\/api\/calendar\/global\/(\d+)$/);
  if (mm) {
    const id = Number(mm[1]);
    if (req.method === "PATCH") {
      if (user.role !== "admin") return json({ error: "forbidden" }, 403);
      return handlePatch(req, ctx, user, id, "global");
    }
    if (req.method === "DELETE") {
      if (user.role !== "admin") return json({ error: "forbidden" }, 403);
      return handleDelete(ctx, user, id, "global");
    }
  }

  // ── Project: list + create ─────────────────────────────────────────────────
  mm = m(/^\/api\/projects\/([^/]+)\/calendar$/);
  if (mm) {
    const projectName = decodeURIComponent(mm[1]!);
    const project = getProject(ctx.db, projectName);
    if (!project) return json({ error: "project not found" }, 404);
    if (req.method === "GET") {
      if (!canSeeProject(project, user)) return json({ error: "forbidden" }, 403);
      return json(listProjectExceptions(ctx.db, projectName));
    }
    if (req.method === "POST") {
      if (!canEditProject(project, user)) return json({ error: "forbidden" }, 403);
      return handleCreateProject(req, ctx, user, projectName);
    }
  }

  // ── Project: patch + delete ───────────────────────────────────────────────
  mm = m(/^\/api\/projects\/([^/]+)\/calendar\/(\d+)$/);
  if (mm) {
    const projectName = decodeURIComponent(mm[1]!);
    const id = Number(mm[2]);
    const project = getProject(ctx.db, projectName);
    if (!project) return json({ error: "project not found" }, 404);
    if (!canEditProject(project, user)) return json({ error: "forbidden" }, 403);
    if (req.method === "PATCH") return handlePatch(req, ctx, user, id, "project");
    if (req.method === "DELETE") return handleDelete(ctx, user, id, "project");
  }

  // ── Planning: non-working date range query (for Gantt) ───────────────────
  mm = m(/^\/api\/planning\/(\d+)\/calendar\/non-working$/);
  if (mm && req.method === "GET") {
    const ppId = Number(mm[1]);
    const pp = getPlanningProject(ctx.db, ppId);
    if (!pp) return json({ error: "planning project not found" }, 404);
    const project = getProject(ctx.db, pp.project);
    if (!project || !canSeeProject(project, user)) return json({ error: "forbidden" }, 403);
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return json({ error: "from and to are required (YYYY-MM-DD)" }, 400);
    }
    const set = buildNonWorkingDateSet(ctx.db, from, to, {
      projectName: pp.project,
      planningProjectId: ppId,
    });
    return json({ nonWorkingDates: Array.from(set).sort() });
  }

  // ── Planning project: list + create ───────────────────────────────────────
  mm = m(/^\/api\/planning\/(\d+)\/calendar$/);
  if (mm) {
    const ppId = Number(mm[1]);
    const pp = getPlanningProject(ctx.db, ppId);
    if (!pp) return json({ error: "planning project not found" }, 404);
    const project = getProject(ctx.db, pp.project);
    if (!project || !canSeeProject(project, user)) return json({ error: "forbidden" }, 403);
    if (req.method === "GET") {
      return json(listPlanningExceptions(ctx.db, ppId));
    }
    if (req.method === "POST") {
      if (!canEditPlanningProject(user, pp, project)) return json({ error: "forbidden" }, 403);
      return handleCreatePlanning(req, ctx, user, ppId);
    }
  }

  // ── Planning project: patch + delete ──────────────────────────────────────
  mm = m(/^\/api\/planning\/(\d+)\/calendar\/(\d+)$/);
  if (mm) {
    const ppId = Number(mm[1]);
    const excId = Number(mm[2]);
    const pp = getPlanningProject(ctx.db, ppId);
    if (!pp) return json({ error: "planning project not found" }, 404);
    const project = getProject(ctx.db, pp.project);
    if (!project || !canEditPlanningProject(user, pp, project)) return json({ error: "forbidden" }, 403);
    if (req.method === "PATCH") return handlePatch(req, ctx, user, excId, "planning");
    if (req.method === "DELETE") return handleDelete(ctx, user, excId, "planning");
  }

  // ── Team: list + create ───────────────────────────────────────────────────
  mm = m(/^\/api\/planning-teams\/(\d+)\/calendar$/);
  if (mm) {
    const teamId = Number(mm[1]);
    const team = getTeam(ctx.db, teamId);
    if (!team) return json({ error: "team not found" }, 404);
    const pp = getPlanningProject(ctx.db, team.planningProjectId);
    if (!pp) return json({ error: "planning project not found" }, 404);
    const project = getProject(ctx.db, pp.project);
    if (!project || !canSeeProject(project, user)) return json({ error: "forbidden" }, 403);
    if (req.method === "GET") {
      return json(listTeamExceptions(ctx.db, teamId));
    }
    if (req.method === "POST") {
      if (!canEditPlanningProject(user, pp, project)) return json({ error: "forbidden" }, 403);
      return handleCreateTeam(req, ctx, user, teamId, team.planningProjectId);
    }
  }

  // ── Team: patch + delete ──────────────────────────────────────────────────
  mm = m(/^\/api\/planning-teams\/(\d+)\/calendar\/(\d+)$/);
  if (mm) {
    const teamId = Number(mm[1]);
    const excId = Number(mm[2]);
    const team = getTeam(ctx.db, teamId);
    if (!team) return json({ error: "team not found" }, 404);
    const pp = getPlanningProject(ctx.db, team.planningProjectId);
    if (!pp) return json({ error: "planning project not found" }, 404);
    const project = getProject(ctx.db, pp.project);
    if (!project || !canEditPlanningProject(user, pp, project)) return json({ error: "forbidden" }, 403);
    if (req.method === "PATCH") return handlePatch(req, ctx, user, excId, "team");
    if (req.method === "DELETE") return handleDelete(ctx, user, excId, "team");
  }

  // ── User (personal): list + create ────────────────────────────────────────
  if (pathname === "/api/users/me/calendar") {
    if (req.method === "GET") {
      return json(listUserExceptions(ctx.db, user.id));
    }
    if (req.method === "POST") {
      return handleCreateUser(req, ctx, user);
    }
  }

  // ── User (personal): patch + delete ──────────────────────────────────────
  mm = m(/^\/api\/users\/me\/calendar\/(\d+)$/);
  if (mm) {
    const id = Number(mm[1]);
    if (req.method === "PATCH") return handlePatchUser(req, ctx, user, id);
    if (req.method === "DELETE") return handleDeleteUser(ctx, user, id);
  }

  return null;
}

// ── Shared patch / delete helpers ─────────────────────────────────────────────

async function handlePatch(
  req: Request,
  ctx: CalendarRouteCtx,
  user: User,
  id: number,
  scope: ExceptionScope,
): Promise<Response> {
  const body = await readJson<{ kind?: string; name?: string }>(req);
  if (!body) return json({ error: "invalid body" }, 400);
  const patch: { kind?: ExceptionKind; name?: string } = {};
  if (body.kind !== undefined) {
    if (body.kind !== "non_working" && body.kind !== "workable") {
      return json({ error: "kind must be non_working or workable" }, 400);
    }
    patch.kind = body.kind;
  }
  if (body.name !== undefined) patch.name = body.name;
  try {
    const exc = updateException(ctx.db, id, patch);
    void ctx.queue.log({
      topic: "calendar",
      kind: "exception.update",
      userId: user.id,
      data: { id, scope, date: exc.date },
    });
    return json(exc);
  } catch {
    return json({ error: "exception not found" }, 404);
  }
}

function handleDelete(
  ctx: CalendarRouteCtx,
  user: User,
  id: number,
  scope: ExceptionScope,
): Response {
  const exc = getException(ctx.db, id);
  if (!exc) return json({ error: "exception not found" }, 404);
  deleteException(ctx.db, id, user.id);
  void ctx.queue.log({
    topic: "calendar",
    kind: "exception.delete",
    userId: user.id,
    data: { id, scope, date: exc.date },
  });
  return json({ ok: true });
}

// ── Create helpers ────────────────────────────────────────────────────────────

async function handleCreateGlobal(
  req: Request,
  ctx: CalendarRouteCtx,
  user: User,
): Promise<Response> {
  const body = await readJson<{
    date?: string;
    kind?: string;
    name?: string;
    countryCode?: string;
  }>(req);
  if (!body?.date || !body.kind) return json({ error: "date and kind are required" }, 400);
  if (!isValidDate(body.date)) return json({ error: "invalid date format" }, 400);
  if (!isValidKind(body.kind)) return json({ error: "kind must be non_working or workable" }, 400);
  try {
    const exc = createGlobalException(ctx.db, {
      date: body.date,
      kind: body.kind,
      name: body.name,
      countryCode: body.countryCode ?? null,
      createdBy: user.id,
    });
    void ctx.queue.log({
      topic: "calendar",
      kind: "exception.create",
      userId: user.id,
      data: { id: exc.id, scope: "global", date: exc.date },
    });
    return json(exc, 201);
  } catch (e) {
    return json({ error: errorMessage(e) }, 409);
  }
}

async function handleCreateProject(
  req: Request,
  ctx: CalendarRouteCtx,
  user: User,
  projectName: string,
): Promise<Response> {
  const body = await readJson<{ date?: string; kind?: string; name?: string }>(req);
  if (!body?.date || !body.kind) return json({ error: "date and kind are required" }, 400);
  if (!isValidDate(body.date)) return json({ error: "invalid date format" }, 400);
  if (!isValidKind(body.kind)) return json({ error: "kind must be non_working or workable" }, 400);
  try {
    const exc = createProjectException(ctx.db, projectName, {
      date: body.date,
      kind: body.kind,
      name: body.name,
      createdBy: user.id,
    });
    void ctx.queue.log({
      topic: "calendar",
      kind: "exception.create",
      userId: user.id,
      data: { id: exc.id, scope: "project", date: exc.date, project: projectName },
    });
    return json(exc, 201);
  } catch (e) {
    return json({ error: errorMessage(e) }, 409);
  }
}

async function handleCreatePlanning(
  req: Request,
  ctx: CalendarRouteCtx,
  user: User,
  ppId: number,
): Promise<Response> {
  const body = await readJson<{ date?: string; kind?: string; name?: string }>(req);
  if (!body?.date || !body.kind) return json({ error: "date and kind are required" }, 400);
  if (!isValidDate(body.date)) return json({ error: "invalid date format" }, 400);
  if (!isValidKind(body.kind)) return json({ error: "kind must be non_working or workable" }, 400);
  try {
    const exc = createPlanningException(ctx.db, ppId, {
      date: body.date,
      kind: body.kind,
      name: body.name,
      createdBy: user.id,
    });
    void ctx.queue.log({
      topic: "calendar",
      kind: "exception.create",
      userId: user.id,
      data: { id: exc.id, scope: "planning", date: exc.date, planningProjectId: ppId },
    });
    return json(exc, 201);
  } catch (e) {
    return json({ error: errorMessage(e) }, 409);
  }
}

async function handleCreateTeam(
  req: Request,
  ctx: CalendarRouteCtx,
  user: User,
  teamId: number,
  planningProjectId: number,
): Promise<Response> {
  const body = await readJson<{ date?: string; kind?: string; name?: string }>(req);
  if (!body?.date || !body.kind) return json({ error: "date and kind are required" }, 400);
  if (!isValidDate(body.date)) return json({ error: "invalid date format" }, 400);
  if (!isValidKind(body.kind)) return json({ error: "kind must be non_working or workable" }, 400);
  try {
    const exc = createTeamException(ctx.db, teamId, planningProjectId, {
      date: body.date,
      kind: body.kind,
      name: body.name,
      createdBy: user.id,
    });
    void ctx.queue.log({
      topic: "calendar",
      kind: "exception.create",
      userId: user.id,
      data: { id: exc.id, scope: "team", date: exc.date, teamId },
    });
    return json(exc, 201);
  } catch (e) {
    return json({ error: errorMessage(e) }, 409);
  }
}

async function handleCreateUser(
  req: Request,
  ctx: CalendarRouteCtx,
  user: User,
): Promise<Response> {
  const body = await readJson<{ date?: string; kind?: string; name?: string }>(req);
  if (!body?.date || !body.kind) return json({ error: "date and kind are required" }, 400);
  if (!isValidDate(body.date)) return json({ error: "invalid date format" }, 400);
  if (!isValidKind(body.kind)) return json({ error: "kind must be non_working or workable" }, 400);
  try {
    const exc = createUserException(ctx.db, user.id, {
      date: body.date,
      kind: body.kind,
      name: body.name,
      createdBy: user.id,
    });
    void ctx.queue.log({
      topic: "calendar",
      kind: "exception.create",
      userId: user.id,
      data: { id: exc.id, scope: "user", date: exc.date },
    });
    return json(exc, 201);
  } catch (e) {
    return json({ error: errorMessage(e) }, 409);
  }
}

async function handlePatchUser(
  req: Request,
  ctx: CalendarRouteCtx,
  user: User,
  id: number,
): Promise<Response> {
  const exc = getException(ctx.db, id);
  if (!exc) return json({ error: "exception not found" }, 404);
  if (exc.userId !== user.id) return json({ error: "forbidden" }, 403);
  return handlePatch(req, ctx, user, id, "user");
}

function handleDeleteUser(
  ctx: CalendarRouteCtx,
  user: User,
  id: number,
): Response {
  const exc = getException(ctx.db, id);
  if (!exc) return json({ error: "exception not found" }, 404);
  if (exc.userId !== user.id) return json({ error: "forbidden" }, 403);
  return handleDelete(ctx, user, id, "user");
}

// ── SSE holiday fetch ─────────────────────────────────────────────────────────

function handleHolidayFetch(
  ctx: CalendarRouteCtx,
  user: User,
  countryCode: string,
  year: number,
): Response {
  void ctx.queue.log({
    topic: "calendar",
    kind: "holidays.fetch",
    userId: user.id,
    data: { countryCode, year },
  });

  const sessionId = `calendar-holidays-${crypto.randomUUID()}`;
  setSessionHiddenFromChat(ctx.db, user.id, sessionId, true);

  const systemPrompt = renderPrompt("calendar.fetch_holidays", {
    country_code: countryCode,
    year,
  });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const sink = controllerSink(controller);
      const renderer = createSseRenderer(sink);
      try {
        const finalAnswer = await runAgent({
          prompt: `Fetch public holidays for ${countryCode} in ${year}.`,
          sessionId,
          userId: user.id,
          project: ctx.cfg.agent.defaultProject,
          llmCfg: ctx.cfg.llm,
          embedCfg: ctx.cfg.embed,
          memoryCfg: ctx.cfg.memory,
          agentCfg: ctx.cfg.agent,
          webCfg: ctx.cfg.web,
          tools: toolsRegistry,
          db: ctx.db,
          queue: ctx.queue,
          renderer,
          systemPromptOverride: systemPrompt,
          originAutomation: false,
        });

        const holidays = extractHolidayJson(finalAnswer);
        if (!holidays) {
          renderer.onError("Agent did not return a valid JSON block");
        } else {
          const count = bulkInsertHolidays(ctx.db, holidays, {
            userId: user.id,
            countryCode,
          });
          void ctx.queue.log({
            topic: "calendar",
            kind: "holidays.fetch.done",
            userId: user.id,
            data: { countryCode, year, count },
          });
          const ev = JSON.stringify({ type: "holidays_inserted", count, countryCode, year });
          sink.enqueue(SSE_ENCODER.encode(`data: ${ev}\n\n`));
        }
      } catch (e) {
        renderer.onError(errorMessage(e));
      } finally {
        finishSse(sink);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Session-Id": sessionId,
    },
  });
}

function extractHolidayJson(
  raw: string,
): Array<{ date: string; name: string }> | null {
  const fencedJson = raw.match(/```json\s*\n([\s\S]*?)\n```/);
  const fencedBare = raw.match(/```\s*\n([\s\S]*?)\n```/);
  const candidates = [fencedJson?.[1], fencedBare?.[1]].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate!);
      if (
        Array.isArray(parsed) &&
        parsed.every(
          (item) =>
            typeof item === "object" &&
            typeof item.date === "string" &&
            typeof item.name === "string",
        )
      ) {
        return parsed;
      }
    } catch {
      // Try next candidate.
    }
  }
  return null;
}

// ── Validation helpers ────────────────────────────────────────────────────────

function isValidDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function isValidKind(s: string): s is ExceptionKind {
  return s === "non_working" || s === "workable";
}
