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
import type { ChatAttachment } from "../llm/types.ts";
import { getSessionOwners, listSessions } from "../memory/sessions.ts";
import { setSessionHiddenFromChat } from "../memory/session_visibility.ts";
import { listEventFacets, listEvents, type ListEventsFilter } from "../memory/events.ts";
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
  parseMemoryOverride,
  writeProjectSystemPrompt,
} from "../memory/project_assets.ts";
import { handleDashboardRoute } from "./dashboard_routes.ts";
import { handleAgentRoute } from "./agent_routes.ts";
import { handleSkillRoute } from "./skill_routes.ts";
import { handleBoardRoute } from "./board_routes.ts";
import { handleWhiteboardRoute } from "./whiteboard_routes.ts";
import { handleDocumentRoute } from "./document_routes.ts";
import { handleWorkspaceRoute } from "./workspace_routes.ts";
import { handleScheduledTaskRoute } from "./scheduled_task_routes.ts";
import type { SchedulerHandle } from "../scheduler/ticker.ts";
import type { HandlerRegistry } from "../scheduler/handlers.ts";
import { parseMention } from "../agent/mention.ts";
import { getAgent, isAgentLinkedToProject } from "../memory/agents.ts";

export interface RouteCtx {
  db: Database;
  queue: BunnyQueue;
  cfg: BunnyConfig;
  scheduler: SchedulerHandle;
  handlerRegistry: HandlerRegistry;
}

export async function handleApi(req: Request, url: URL, ctx: RouteCtx): Promise<Response> {
  const { pathname } = url;

  // Auth / user / apikey routes take precedence.
  const authResponse = await handleAuthRoute(req, url, ctx);
  if (authResponse) return authResponse;

  // All remaining /api/* routes require an authenticated user.
  const user = await authenticate(ctx.db, req);
  if (!user) return json({ error: "unauthorized" }, 401);

  // ── Dashboard (stats) ─────────────────────────────────────────────────────
  const dashResponse = handleDashboardRoute(req, url, { db: ctx.db }, user);
  if (dashResponse) return dashResponse;

  // ── Agents & tool catalogue ───────────────────────────────────────────────
  const agentResponse = await handleAgentRoute(
    req,
    url,
    { db: ctx.db, queue: ctx.queue, defaultProject: ctx.cfg.agent.defaultProject },
    user,
  );
  if (agentResponse) return agentResponse;

  // ── Skills ────────────────────────────────────────────────────────────────
  const skillResponse = await handleSkillRoute(
    req,
    url,
    { db: ctx.db, queue: ctx.queue, defaultProject: ctx.cfg.agent.defaultProject },
    user,
  );
  if (skillResponse) return skillResponse;

  // ── Board (kanban) ────────────────────────────────────────────────────────
  // Mounted before the generic project routes so /api/projects/:p/board hits
  // here instead of returning a 404 from the project handler.
  const boardResponse = await handleBoardRoute(
    req,
    url,
    { db: ctx.db, queue: ctx.queue, cfg: ctx.cfg },
    user,
  );
  if (boardResponse) return boardResponse;

  // ── Whiteboards (per-project Excalidraw) ──────────────────────────────────
  const whiteboardResponse = await handleWhiteboardRoute(req, url, { db: ctx.db, queue: ctx.queue, cfg: ctx.cfg }, user);
  if (whiteboardResponse) return whiteboardResponse;

  // ── Documents (per-project rich-text) ─────────────────────────────────────
  const documentResponse = await handleDocumentRoute(req, url, { db: ctx.db, queue: ctx.queue, cfg: ctx.cfg }, user);
  if (documentResponse) return documentResponse;

  // ── Workspace (per-project files) ─────────────────────────────────────────
  const workspaceResponse = await handleWorkspaceRoute(req, url, { db: ctx.db, queue: ctx.queue }, user);
  if (workspaceResponse) return workspaceResponse;

  // ── Scheduler (system + user tasks) ───────────────────────────────────────
  const taskResponse = await handleScheduledTaskRoute(
    req,
    url,
    { db: ctx.db, queue: ctx.queue, scheduler: ctx.scheduler, registry: ctx.handlerRegistry },
    user,
  );
  if (taskResponse) return taskResponse;

  // ── UI config (public subset of bunny.config.toml) ────────────────────────
  if (pathname === "/api/config/ui" && req.method === "GET") {
    return json({ autosaveIntervalMs: ctx.cfg.ui.autosaveIntervalMs });
  }

  // ── Events (admin Logs tab) ───────────────────────────────────────────────
  if (pathname === "/api/events" && req.method === "GET") {
    if (user.role !== "admin") return json({ error: "forbidden" }, 403);
    const filter = parseEventsFilter(url);
    return json(listEvents(ctx.db, filter));
  }
  if (pathname === "/api/events/facets" && req.method === "GET") {
    if (user.role !== "admin") return json({ error: "forbidden" }, 403);
    return json(listEventFacets(ctx.db));
  }

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

  // GET /api/sessions?q=...&scope=mine|all&project=<name>&excludeHidden=1
  if (pathname === "/api/sessions" && req.method === "GET") {
    const q = url.searchParams.get("q") ?? undefined;
    const scope = url.searchParams.get("scope") ?? "mine";
    const projectParam = url.searchParams.get("project")?.trim();
    const excludeHidden = url.searchParams.get("excludeHidden") === "1";
    // Admins may opt-in to the global view with scope=all; everyone else is
    // always restricted to their own sessions.
    const allowAll = user.role === "admin" && scope === "all";
    const filter: { userId?: string; project?: string } = allowAll ? {} : { userId: user.id };
    if (projectParam) filter.project = projectParam;
    const sessions = listSessions(ctx.db, {
      search: q,
      ...filter,
      viewerId: user.id,
      excludeHidden,
    });
    return json({ sessions });
  }

  // PATCH /api/sessions/:id — toggle per-user visibility flags
  const sessionPatchMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionPatchMatch && req.method === "PATCH") {
    const sessionId = decodeURIComponent(sessionPatchMatch[1]!);
    if (!canAccessSession(ctx, user, sessionId)) {
      return json({ error: "forbidden" }, 403);
    }
    let body: { hiddenFromChat?: boolean };
    try {
      body = (await req.json()) as { hiddenFromChat?: boolean };
    } catch {
      return json({ error: "invalid json" }, 400);
    }
    if (typeof body.hiddenFromChat !== "boolean") {
      return json({ error: "hiddenFromChat (boolean) is required" }, 400);
    }
    setSessionHiddenFromChat(ctx.db, user.id, sessionId, body.hiddenFromChat);
    void ctx.queue.log({ topic: "session", kind: "update", userId: user.id, data: { sessionId, hiddenFromChat: body.hiddenFromChat } });
    return json({ ok: true, sessionId, hiddenFromChat: body.hiddenFromChat });
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

  // POST /api/upload-image — convert an uploaded image to a base64 data URL.
  // Used by the frontend when client-side File reading APIs are unavailable
  // (Safari 26+ blocks FileReader / arrayBuffer on File objects).
  if (pathname === "/api/upload-image" && req.method === "POST") {
    return handleUploadImage(req);
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
  interface ChatBody {
    sessionId?: string;
    prompt?: string;
    project?: string;
    agent?: string;
    attachments?: Array<{ kind?: string; mime?: string; dataUrl?: string }>;
  }
  let body: ChatBody;
  try {
    body = (await req.json()) as ChatBody;
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const rawPrompt = body.prompt?.trim();
  const sessionId = body.sessionId?.trim() || randomUUID();
  if (!rawPrompt) return json({ error: "missing prompt" }, 400);

  // Validate & normalise attachments. Cap: 4 images, 10 MB per image (the
  // base64 payload; raw bytes are ≈ 0.75× that).
  const MAX_ATTACHMENTS = 4;
  const MAX_DATAURL_BYTES = 10 * 1024 * 1024;
  const ALLOWED_IMG_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
  const attachments: ChatAttachment[] = [];
  if (body.attachments) {
    if (!Array.isArray(body.attachments) || body.attachments.length > MAX_ATTACHMENTS) {
      return json({ error: `at most ${MAX_ATTACHMENTS} attachments allowed` }, 400);
    }
    for (const a of body.attachments) {
      if (a?.kind !== "image") return json({ error: "unsupported attachment kind" }, 400);
      if (typeof a.mime !== "string" || !ALLOWED_IMG_MIME.has(a.mime)) {
        return json({ error: `unsupported image mime '${a.mime}'` }, 400);
      }
      if (typeof a.dataUrl !== "string" || !a.dataUrl.startsWith(`data:${a.mime};base64,`)) {
        return json({ error: "attachment dataUrl must be a base64 data URL" }, 400);
      }
      if (a.dataUrl.length > MAX_DATAURL_BYTES) {
        return json({ error: "attachment exceeds size limit" }, 413);
      }
      attachments.push({ kind: "image", mime: a.mime, dataUrl: a.dataUrl });
    }
  }

  // Resolve the addressed agent: explicit body.agent wins, otherwise parse a
  // leading `@name` from the prompt. Either path strips the mention so the
  // agent doesn't see its own handle in its instructions.
  let prompt = rawPrompt;
  let agentName: string | undefined = body.agent?.trim() || undefined;
  if (!agentName) {
    const parsed = parseMention(rawPrompt);
    if (parsed.agent) {
      if (!parsed.cleaned.trim()) {
        return json({ error: "missing prompt after @mention" }, 400);
      }
      agentName = parsed.agent;
      prompt = parsed.cleaned;
    }
  }

  if (!canAccessSession(ctx, user, sessionId)) {
    return json({ error: "forbidden" }, 403);
  }

  // Resolve + validate project: must match any existing session context.
  let project: string;
  try {
    const requested = body.project ? validateProjectName(body.project) : undefined;
    const existing = getSessionProject(ctx.db, sessionId);
    if (existing !== null) {
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

  // Validate agent (if any) — must exist and be linked to this project.
  if (agentName) {
    const a = getAgent(ctx.db, agentName);
    if (!a) return json({ error: `agent '${agentName}' does not exist` }, 404);
    if (!isAgentLinkedToProject(ctx.db, project, agentName)) {
      return json(
        { error: `agent '${agentName}' is not available in project '${project}'` },
        403,
      );
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const sink = controllerSink(controller);
      const renderer = createSseRenderer(sink, { author: agentName });

      try {
        await runAgent({
          prompt,
          attachments: attachments.length > 0 ? attachments : undefined,
          sessionId,
          userId: user.id,
          project,
          agent: agentName,
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
      ...(agentName ? { "X-Agent": agentName } : {}),
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

export function canSeeProject(p: Project, user: User): boolean {
  if (p.visibility === "public") return true;
  if (user.role === "admin") return true;
  return p.createdBy === user.id;
}

export function canEditProject(p: Project, user: User): boolean {
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

interface ProjectBody {
  name?: string;
  description?: string | null;
  systemPrompt?: string;
  appendMode?: boolean;
  visibility?: ProjectVisibility;
  lastN?: number | null;
  recallK?: number | null;
}

async function handleCreateProject(req: Request, ctx: RouteCtx, user: User): Promise<Response> {
  let body: ProjectBody;
  try {
    body = (await req.json()) as ProjectBody;
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  try {
    const name = validateProjectName(body.name ?? "");
    if (getProject(ctx.db, name)) {
      return json({ error: `project '${name}' already exists` }, 409);
    }
    const created = createProject(ctx.db, {
      name,
      description: body.description ?? null,
      visibility: body.visibility === "private" ? "private" : "public",
      createdBy: user.id,
    });
    // Fresh project: mkdir then write once. No second load/overwrite.
    ensureProjectDir(name);
    writeProjectSystemPrompt(
      name,
      { prompt: body.systemPrompt ?? "", append: body.appendMode !== false },
      { lastN: parseMemoryOverride(body.lastN), recallK: parseMemoryOverride(body.recallK) },
    );
    void ctx.queue.log({ topic: "project", kind: "create", userId: user.id, data: { name, visibility: body.visibility ?? "public", description: body.description ?? null, hasSystemPrompt: !!(body.systemPrompt) } });
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
  let body: ProjectBody;
  try {
    body = (await req.json()) as ProjectBody;
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
      // writeProjectSystemPrompt internally merges with the current on-disk
      // state, so partial patches only need to name the fields that changed.
      const sp: Partial<{ prompt: string; append: boolean }> = {};
      if (body.systemPrompt !== undefined) sp.prompt = body.systemPrompt;
      if (body.appendMode !== undefined) sp.append = body.appendMode;
      const memory = touchesMemory
        ? {
            ...(body.lastN !== undefined ? { lastN: parseMemoryOverride(body.lastN) } : {}),
            ...(body.recallK !== undefined ? { recallK: parseMemoryOverride(body.recallK) } : {}),
          }
        : undefined;
      writeProjectSystemPrompt(name, sp, memory);
    }
    const changed = Object.keys(body).filter((k) => (body as Record<string, unknown>)[k] !== undefined);
    void ctx.queue.log({ topic: "project", kind: "update", userId: user.id, data: { name, changed } });
    return json({ project: toProjectDto(updated) });
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

function parseEventsFilter(url: URL): ListEventsFilter {
  const p = url.searchParams;
  const numParam = (k: string): number | undefined => {
    const v = p.get(k);
    if (v === null || v === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const strParam = (k: string): string | undefined => {
    const v = p.get(k)?.trim();
    return v ? v : undefined;
  };
  return {
    topic: strParam("topic"),
    kind: strParam("kind"),
    sessionId: strParam("session_id"),
    userId: strParam("user_id"),
    errorsOnly: p.get("errors_only") === "1" || p.get("errors_only") === "true",
    fromTs: numParam("from"),
    toTs: numParam("to"),
    q: strParam("q"),
    limit: numParam("limit"),
    offset: numParam("offset"),
  };
}

function handleDeleteProject(ctx: RouteCtx, user: User, name: string): Response {
  const p = getProject(ctx.db, name);
  if (!p) return json({ error: "not found" }, 404);
  if (!canEditProject(p, user)) return json({ error: "forbidden" }, 403);
  try {
    deleteProject(ctx.db, name);
    void ctx.queue.log({ topic: "project", kind: "delete", userId: user.id, data: { name } });
    return json({ ok: true });
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

// ── Image upload (browser‐side FileReader workaround) ──────────────────────

const UPLOAD_ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

async function handleUploadImage(req: Request): Promise<Response> {
  let form: globalThis.FormData;
  try {
    form = await req.formData() as unknown as globalThis.FormData;
  } catch {
    return json({ error: "expected multipart/form-data" }, 400);
  }
  const file = form.get("file");
  if (!file || !(file instanceof File)) {
    return json({ error: "missing 'file' field" }, 400);
  }
  if (!UPLOAD_ALLOWED_MIME.has(file.type)) {
    return json({ error: `unsupported mime '${file.type}'` }, 400);
  }
  if (file.size > UPLOAD_MAX_BYTES) {
    return json({ error: "file too large" }, 413);
  }
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const base64 = Buffer.from(bytes).toString("base64");
  const dataUrl = `data:${file.type};base64,${base64}`;
  return json({ mime: file.type, dataUrl });
}
