/**
 * HTTP routes for the Bunny web UI.
 *
 * Thin adapter — each route delegates to existing memory / agent modules.
 * Plain switch on `pathname` keeps us framework-free.
 */

import type { Database } from "bun:sqlite";
import type { BunnyConfig } from "../config.ts";
import type { BunnyQueue } from "../queue/bunqueue.ts";
import { randomUUID } from "node:crypto";

import { getMessagesBySession } from "../memory/messages.ts";
import { getSessionOwners, listSessions } from "../memory/sessions.ts";
import { runAgent } from "../agent/loop.ts";
import { createSseRenderer, controllerSink, finishSse } from "../agent/render_sse.ts";
import { registry } from "../tools/index.ts";
import { errorMessage } from "../util/error.ts";
import { authenticate } from "./auth_middleware.ts";
import { handleAuthRoute } from "./auth_routes.ts";
import { json } from "./http.ts";
import type { User } from "../auth/users.ts";
import {
  createProject,
  deleteProject,
  getProject,
  getSessionProject,
  listProjects,
  updateProject,
  validateProjectName,
  type Project,
  type ProjectVisibility,
} from "../memory/projects.ts";
import {
  ensureProjectDir,
  loadProjectAssets,
  writeProjectSystemPrompt,
} from "../memory/project_assets.ts";

export interface RouteCtx {
  db: Database;
  queue: BunnyQueue;
  cfg: BunnyConfig;
}

export async function handleApi(req: Request, url: URL, ctx: RouteCtx): Promise<Response> {
  const { pathname } = url;

  // Auth / user / apikey routes take precedence.
  const authResponse = await handleAuthRoute(req, url, ctx);
  if (authResponse) return authResponse;

  // All remaining /api/* routes require an authenticated user.
  const user = await authenticate(ctx.db, req);
  if (!user) return json({ error: "unauthorized" }, 401);

  // ── Projects ──────────────────────────────────────────────────────────────
  if (pathname === "/api/projects" && req.method === "GET") {
    const projects = listProjects(ctx.db).filter((p) => canSeeProject(p, user));
    return json({
      projects: projects.map((p) => toProjectDto(p)),
    });
  }
  if (pathname === "/api/projects" && req.method === "POST") {
    return handleCreateProject(req, ctx, user);
  }
  const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (projectMatch) {
    const name = decodeURIComponent(projectMatch[1]!);
    if (req.method === "GET") return handleGetProject(ctx, user, name);
    if (req.method === "PATCH") return handlePatchProject(req, ctx, user, name);
    if (req.method === "DELETE") return handleDeleteProject(ctx, user, name);
  }

  // GET /api/sessions?q=...&scope=mine|all&project=<name>
  if (pathname === "/api/sessions" && req.method === "GET") {
    const q = url.searchParams.get("q") ?? undefined;
    const scope = url.searchParams.get("scope") ?? "mine";
    const projectParam = url.searchParams.get("project")?.trim();
    // Admins may opt-in to the global view with scope=all; everyone else is
    // always restricted to their own sessions.
    const allowAll = user.role === "admin" && scope === "all";
    const filter: { userId?: string; project?: string } = allowAll ? {} : { userId: user.id };
    if (projectParam) filter.project = projectParam;
    const sessions = listSessions(ctx.db, { search: q, ...filter });
    return json({ sessions });
  }

  // POST /api/sessions → create a new session id
  if (pathname === "/api/sessions" && req.method === "POST") {
    return json({ sessionId: randomUUID() }, 201);
  }

  // GET /api/sessions/:id/messages
  const msgMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
  if (msgMatch && req.method === "GET") {
    const sessionId = decodeURIComponent(msgMatch[1]!);
    if (!canAccessSession(ctx, user, sessionId)) {
      return json({ error: "forbidden" }, 403);
    }
    const messages = getMessagesBySession(ctx.db, sessionId);
    return json({ sessionId, messages });
  }

  // POST /api/chat — SSE streaming chat
  if (pathname === "/api/chat" && req.method === "POST") {
    return handleChat(req, ctx, user);
  }

  return json({ error: "not found", path: pathname }, 404);
}

function canAccessSession(ctx: RouteCtx, user: User, sessionId: string): boolean {
  if (user.role === "admin") return true;
  const owners = getSessionOwners(ctx.db, sessionId);
  if (owners.length === 0) return true; // legacy / anonymous session — allow
  return owners.includes(user.id);
}

async function handleChat(req: Request, ctx: RouteCtx, user: User): Promise<Response> {
  let body: { sessionId?: string; prompt?: string; project?: string };
  try {
    body = (await req.json()) as { sessionId?: string; prompt?: string; project?: string };
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const prompt = body.prompt?.trim();
  const sessionId = body.sessionId?.trim() || randomUUID();
  if (!prompt) return json({ error: "missing prompt" }, 400);

  if (!canAccessSession(ctx, user, sessionId)) {
    return json({ error: "forbidden" }, 403);
  }

  // Resolve + validate project: must match any existing session context.
  let project: string;
  try {
    const requested = body.project ? validateProjectName(body.project) : undefined;
    const existing = getSessionProject(ctx.db, sessionId);
    const sessionHasRows = ctx.db
      .prepare(`SELECT 1 AS x FROM messages WHERE session_id = ? LIMIT 1`)
      .get(sessionId) as { x: number } | undefined;
    if (sessionHasRows) {
      if (requested && requested !== existing) {
        return json(
          { error: `session belongs to project '${existing}', got '${requested}'` },
          409,
        );
      }
      project = existing;
    } else {
      project = requested ?? validateProjectName(ctx.cfg.agent.defaultProject);
    }
    const pr = getProject(ctx.db, project);
    if (!pr) return json({ error: `project '${project}' does not exist` }, 404);
    if (!canSeeProject(pr, user)) return json({ error: "forbidden" }, 403);
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const sink = controllerSink(controller);
      const renderer = createSseRenderer(sink);

      try {
        await runAgent({
          prompt,
          sessionId,
          userId: user.id,
          project,
          llmCfg: ctx.cfg.llm,
          embedCfg: ctx.cfg.embed,
          memoryCfg: ctx.cfg.memory,
          agentCfg: ctx.cfg.agent,
          tools: registry,
          db: ctx.db,
          queue: ctx.queue,
          renderer,
        });
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
      "X-Project": project,
    },
  });
}

// ── Project helpers ─────────────────────────────────────────────────────────

interface ProjectDto {
  name: string;
  description: string | null;
  visibility: ProjectVisibility;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
  systemPrompt: string;
  appendMode: boolean;
  /** null = inherit global [memory] default. */
  lastN: number | null;
  /** null = inherit global [memory] default. */
  recallK: number | null;
}

function canSeeProject(p: Project, user: User): boolean {
  if (p.visibility === "public") return true;
  if (user.role === "admin") return true;
  return p.createdBy === user.id;
}

function canEditProject(p: Project, user: User): boolean {
  if (user.role === "admin") return true;
  return p.createdBy === user.id;
}

function toProjectDto(p: Project): ProjectDto {
  let systemPrompt = "";
  let appendMode = true;
  let lastN: number | null = null;
  let recallK: number | null = null;
  try {
    const assets = loadProjectAssets(p.name);
    systemPrompt = assets.systemPrompt.prompt;
    appendMode = assets.systemPrompt.append;
    lastN = assets.memory.lastN;
    recallK = assets.memory.recallK;
  } catch {
    // Invalid name on disk (shouldn't happen post-validation) — fall through with defaults.
  }
  return {
    name: p.name,
    description: p.description,
    visibility: p.visibility,
    createdBy: p.createdBy,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    systemPrompt,
    appendMode,
    lastN,
    recallK,
  };
}

async function handleCreateProject(req: Request, ctx: RouteCtx, user: User): Promise<Response> {
  let body: {
    name?: string;
    description?: string | null;
    systemPrompt?: string;
    appendMode?: boolean;
    visibility?: ProjectVisibility;
    lastN?: number | null;
    recallK?: number | null;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  try {
    const name = validateProjectName(body.name ?? "");
    if (getProject(ctx.db, name)) {
      return json({ error: `project '${name}' already exists` }, 409);
    }
    const lastN = coerceOverride(body.lastN);
    const recallK = coerceOverride(body.recallK);
    const created = createProject(ctx.db, {
      name,
      description: body.description ?? null,
      visibility: body.visibility === "private" ? "private" : "public",
      createdBy: user.id,
    });
    ensureProjectDir(name, {
      systemPrompt: { prompt: body.systemPrompt ?? "", append: body.appendMode !== false },
      memory: { lastN, recallK },
    });
    // The ensure helper only writes the stub on first creation; if the caller
    // passed explicit fields, overwrite to make sure they stick.
    if (
      body.systemPrompt !== undefined ||
      body.appendMode !== undefined ||
      body.lastN !== undefined ||
      body.recallK !== undefined
    ) {
      writeProjectSystemPrompt(
        name,
        { prompt: body.systemPrompt ?? "", append: body.appendMode !== false },
        { lastN, recallK },
      );
    }
    return json({ project: toProjectDto(created) }, 201);
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

function handleGetProject(ctx: RouteCtx, user: User, name: string): Response {
  const p = getProject(ctx.db, name);
  if (!p) return json({ error: "not found" }, 404);
  if (!canSeeProject(p, user)) return json({ error: "forbidden" }, 403);
  return json({ project: toProjectDto(p) });
}

async function handlePatchProject(
  req: Request,
  ctx: RouteCtx,
  user: User,
  name: string,
): Promise<Response> {
  const p = getProject(ctx.db, name);
  if (!p) return json({ error: "not found" }, 404);
  if (!canEditProject(p, user)) return json({ error: "forbidden" }, 403);
  let body: {
    description?: string | null;
    systemPrompt?: string;
    appendMode?: boolean;
    visibility?: ProjectVisibility;
    lastN?: number | null;
    recallK?: number | null;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  try {
    const updated = updateProject(ctx.db, name, {
      description: body.description,
      visibility: body.visibility,
    });
    const touchesPrompt = body.systemPrompt !== undefined || body.appendMode !== undefined;
    const touchesMemory = body.lastN !== undefined || body.recallK !== undefined;
    if (touchesPrompt || touchesMemory) {
      const current = loadProjectAssets(name);
      writeProjectSystemPrompt(
        name,
        {
          prompt: body.systemPrompt ?? current.systemPrompt.prompt,
          append: body.appendMode !== undefined ? body.appendMode : current.systemPrompt.append,
        },
        touchesMemory
          ? {
              lastN: body.lastN === undefined ? current.memory.lastN : coerceOverride(body.lastN),
              recallK:
                body.recallK === undefined ? current.memory.recallK : coerceOverride(body.recallK),
            }
          : undefined,
      );
    }
    return json({ project: toProjectDto(updated) });
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

/** Normalise an incoming override: `null`/negative/invalid → null; else floor to int. */
function coerceOverride(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

function handleDeleteProject(ctx: RouteCtx, user: User, name: string): Response {
  const p = getProject(ctx.db, name);
  if (!p) return json({ error: "not found" }, 404);
  if (!canEditProject(p, user)) return json({ error: "forbidden" }, 403);
  try {
    deleteProject(ctx.db, name);
    return json({ ok: true });
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}
