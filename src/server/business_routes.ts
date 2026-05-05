import type { Database } from "bun:sqlite";
import type { User } from "../auth/users.ts";
import type { BunnyConfig } from "../config.ts";
import type { BunnyQueue } from "../queue/bunqueue.ts";
import { errorMessage } from "../util/error.ts";
import { json, readJson } from "./http.ts";
import { canSeeProject } from "./routes.ts";
import {
  getProject,
  validateProjectName,
  type Project,
} from "../memory/projects.ts";
import {
  setSessionHiddenFromChat,
  setSessionQuickChat,
} from "../memory/session_visibility.ts";
import { runAgent } from "../agent/loop.ts";
import {
  controllerSink,
  createSseRenderer,
  finishSse,
} from "../agent/render_sse.ts";
import { registry as toolsRegistry } from "../tools/index.ts";
import {
  canEditBusiness,
  createBusiness,
  deleteBusiness,
  getBusiness,
  listBusinesses,
  setBusinessSoulManual,
  updateBusiness,
} from "../memory/businesses.ts";
import { listBusinessContactLinks } from "../memory/contacts.ts";
import { ENTITY_SOUL_CHAR_LIMIT } from "../memory/entity_soul_constants.ts";
import { refreshOneBusinessSoul } from "../businesses/soul_refresh_handler.ts";
import { runBusinessAutoBuild } from "../businesses/auto_build_handler.ts";
import { resolvePrompt } from "../prompts/resolve.ts";

export interface BusinessRouteCtx {
  db: Database;
  queue: BunnyQueue;
  cfg: BunnyConfig;
}

export async function handleBusinessRoute(
  req: Request,
  url: URL,
  ctx: BusinessRouteCtx,
  user: User,
): Promise<Response | null> {
  const { pathname } = url;

  const listMatch = pathname.match(/^\/api\/projects\/([^/]+)\/businesses$/);
  if (listMatch) {
    const project = decodeURIComponent(listMatch[1]!);
    if (req.method === "GET") return handleList(ctx, user, project, url);
    if (req.method === "POST") return handleCreate(req, ctx, user, project);
  }

  const autoBuildMatch = pathname.match(
    /^\/api\/projects\/([^/]+)\/businesses\/auto-build$/,
  );
  if (autoBuildMatch) {
    const project = decodeURIComponent(autoBuildMatch[1]!);
    if (req.method === "POST") return handleAutoBuild(ctx, user, project);
  }

  const editMatch = pathname.match(
    /^\/api\/projects\/([^/]+)\/businesses\/edit$/,
  );
  if (editMatch) {
    const project = decodeURIComponent(editMatch[1]!);
    if (req.method === "POST") return handleEdit(req, ctx, user, project);
  }

  const askMatch = pathname.match(
    /^\/api\/projects\/([^/]+)\/businesses\/ask$/,
  );
  if (askMatch) {
    const project = decodeURIComponent(askMatch[1]!);
    if (req.method === "POST") return handleAsk(req, ctx, user, project);
  }

  const soulMatch = pathname.match(
    /^\/api\/projects\/([^/]+)\/businesses\/(\d+)\/soul$/,
  );
  if (soulMatch) {
    const project = decodeURIComponent(soulMatch[1]!);
    const id = Number(soulMatch[2]);
    if (req.method === "PUT") return handleSoulPut(req, ctx, user, project, id);
  }

  const soulRefreshMatch = pathname.match(
    /^\/api\/projects\/([^/]+)\/businesses\/(\d+)\/soul\/refresh$/,
  );
  if (soulRefreshMatch) {
    const project = decodeURIComponent(soulRefreshMatch[1]!);
    const id = Number(soulRefreshMatch[2]);
    if (req.method === "POST") return handleSoulRefresh(ctx, user, project, id);
  }

  const contactsMatch = pathname.match(
    /^\/api\/projects\/([^/]+)\/businesses\/(\d+)\/contacts$/,
  );
  if (contactsMatch) {
    const project = decodeURIComponent(contactsMatch[1]!);
    const id = Number(contactsMatch[2]);
    if (req.method === "GET")
      return handleListLinkedContacts(ctx, user, project, id);
  }

  const idMatch = pathname.match(
    /^\/api\/projects\/([^/]+)\/businesses\/(\d+)$/,
  );
  if (idMatch) {
    const project = decodeURIComponent(idMatch[1]!);
    const id = Number(idMatch[2]);
    if (req.method === "GET") return handleGet(ctx, user, project, id);
    if (req.method === "PATCH") return handlePatch(req, ctx, user, project, id);
    if (req.method === "DELETE") return handleDelete(ctx, user, project, id);
  }

  return null;
}

// ── helpers ─────────────────────────────────────────────────────────────────

type ResolveOk = { ok: true; project: string; p: Project };
type ResolveErr = { ok: false; error: Response };

function resolveProject(
  ctx: BusinessRouteCtx,
  user: User,
  rawProject: string,
): ResolveOk | ResolveErr {
  let project: string;
  try {
    project = validateProjectName(rawProject);
  } catch (e) {
    return { ok: false, error: json({ error: errorMessage(e) }, 400) };
  }
  const p = getProject(ctx.db, project);
  if (!p)
    return { ok: false, error: json({ error: "project not found" }, 404) };
  if (!canSeeProject(p, user))
    return { ok: false, error: json({ error: "forbidden" }, 403) };
  return { ok: true, project, p };
}

// ── handlers ────────────────────────────────────────────────────────────────

function handleList(
  ctx: BusinessRouteCtx,
  user: User,
  rawProject: string,
  url: URL,
): Response {
  const r = resolveProject(ctx, user, rawProject);
  if (!r.ok) return r.error;
  const search = url.searchParams.get("q") || undefined;
  const limit = url.searchParams.has("limit")
    ? Number(url.searchParams.get("limit"))
    : undefined;
  const offset = url.searchParams.has("offset")
    ? Number(url.searchParams.get("offset"))
    : undefined;
  return json(listBusinesses(ctx.db, r.project, { search, limit, offset }));
}

async function handleCreate(
  req: Request,
  ctx: BusinessRouteCtx,
  user: User,
  rawProject: string,
): Promise<Response> {
  const r = resolveProject(ctx, user, rawProject);
  if (!r.ok) return r.error;
  const body = await readJson<Record<string, unknown>>(req);
  if (!body) return json({ error: "invalid json" }, 400);
  const name = body["name"];
  if (typeof name !== "string" || !name.trim())
    return json({ error: "missing name" }, 400);
  try {
    const domain = body["domain"];
    const description = body["description"];
    const notes = body["notes"];
    const website = body["website"];
    const emails = body["emails"];
    const phones = body["phones"];
    const socials = body["socials"];
    const logo = body["logo"];
    const tags = body["tags"];
    const business = createBusiness(ctx.db, {
      project: r.project,
      name,
      domain: typeof domain === "string" ? domain : null,
      description: typeof description === "string" ? description : "",
      notes: typeof notes === "string" ? notes : "",
      website: typeof website === "string" ? website : null,
      emails: Array.isArray(emails)
        ? emails.filter((e): e is string => typeof e === "string")
        : [],
      phones: Array.isArray(phones)
        ? phones.filter((p): p is string => typeof p === "string")
        : [],
      socials: Array.isArray(socials)
        ? (socials as Parameters<typeof createBusiness>[1]["socials"])
        : [],
      logo: typeof logo === "string" ? logo : null,
      tags: Array.isArray(tags)
        ? tags.filter((t): t is string => typeof t === "string")
        : [],
      source: "manual",
      createdBy: user.id,
    });
    void ctx.queue.log({
      topic: "business",
      kind: "create",
      userId: user.id,
      data: { id: business.id, project: r.project },
    });
    return json({ business }, 201);
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

function handleGet(
  ctx: BusinessRouteCtx,
  user: User,
  rawProject: string,
  id: number,
): Response {
  const r = resolveProject(ctx, user, rawProject);
  if (!r.ok) return r.error;
  const business = getBusiness(ctx.db, id);
  if (!business || business.project !== r.project)
    return json({ error: "not found" }, 404);
  return json({ business });
}

async function handlePatch(
  req: Request,
  ctx: BusinessRouteCtx,
  user: User,
  rawProject: string,
  id: number,
): Promise<Response> {
  const r = resolveProject(ctx, user, rawProject);
  if (!r.ok) return r.error;
  const business = getBusiness(ctx.db, id);
  if (!business || business.project !== r.project)
    return json({ error: "not found" }, 404);
  if (!canEditBusiness(user, business, r.p))
    return json({ error: "forbidden" }, 403);
  const body = await readJson<Record<string, unknown>>(req);
  if (!body) return json({ error: "invalid json" }, 400);
  try {
    const updated = updateBusiness(ctx.db, id, body);
    void ctx.queue.log({
      topic: "business",
      kind: "update",
      userId: user.id,
      data: { id, project: r.project },
    });
    return json({ business: updated });
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

function handleDelete(
  ctx: BusinessRouteCtx,
  user: User,
  rawProject: string,
  id: number,
): Response {
  const r = resolveProject(ctx, user, rawProject);
  if (!r.ok) return r.error;
  const business = getBusiness(ctx.db, id);
  if (!business || business.project !== r.project)
    return json({ error: "not found" }, 404);
  if (!canEditBusiness(user, business, r.p))
    return json({ error: "forbidden" }, 403);
  deleteBusiness(ctx.db, id, user.id);
  void ctx.queue.log({
    topic: "business",
    kind: "delete",
    userId: user.id,
    data: { id, project: r.project, soft: true },
  });
  return json({ ok: true });
}

async function handleSoulPut(
  req: Request,
  ctx: BusinessRouteCtx,
  user: User,
  rawProject: string,
  id: number,
): Promise<Response> {
  const r = resolveProject(ctx, user, rawProject);
  if (!r.ok) return r.error;
  const business = getBusiness(ctx.db, id);
  if (!business || business.project !== r.project)
    return json({ error: "not found" }, 404);
  if (!canEditBusiness(user, business, r.p))
    return json({ error: "forbidden" }, 403);
  const body = await readJson<{ soul?: string }>(req);
  if (typeof body?.soul !== "string")
    return json({ error: "missing soul" }, 400);
  if (body.soul.length > ENTITY_SOUL_CHAR_LIMIT)
    return json(
      { error: `soul exceeds ${ENTITY_SOUL_CHAR_LIMIT}-char cap` },
      400,
    );
  try {
    setBusinessSoulManual(ctx.db, id, body.soul, {
      markStale: ctx.cfg.businesses.translateSoul,
    });
    void ctx.queue.log({
      topic: "business",
      kind: "soul.update",
      userId: user.id,
      data: { id, project: r.project, chars: body.soul.length },
    });
    return json({ business: getBusiness(ctx.db, id)! });
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

async function handleSoulRefresh(
  ctx: BusinessRouteCtx,
  user: User,
  rawProject: string,
  id: number,
): Promise<Response> {
  const r = resolveProject(ctx, user, rawProject);
  if (!r.ok) return r.error;
  const business = getBusiness(ctx.db, id);
  if (!business || business.project !== r.project)
    return json({ error: "not found" }, 404);
  if (!canEditBusiness(user, business, r.p))
    return json({ error: "forbidden" }, 403);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const sink = controllerSink(controller);
      const renderer = createSseRenderer(sink);
      try {
        const outcome = await refreshOneBusinessSoul({
          db: ctx.db,
          queue: ctx.queue,
          cfg: ctx.cfg,
          business,
          renderer,
        });
        if (outcome === "lost_race")
          renderer.onError("another refresh is already in progress");
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
    },
  });
}

function handleListLinkedContacts(
  ctx: BusinessRouteCtx,
  user: User,
  rawProject: string,
  id: number,
): Response {
  const r = resolveProject(ctx, user, rawProject);
  if (!r.ok) return r.error;
  const business = getBusiness(ctx.db, id);
  if (!business || business.project !== r.project)
    return json({ error: "not found" }, 404);
  return json({ links: listBusinessContactLinks(ctx.db, id) });
}

async function handleAutoBuild(
  ctx: BusinessRouteCtx,
  user: User,
  rawProject: string,
): Promise<Response> {
  const r = resolveProject(ctx, user, rawProject);
  if (!r.ok) return r.error;
  if (user.role !== "admin" && r.p.createdBy !== user.id)
    return json({ error: "forbidden" }, 403);

  if (!r.p.autoBuildBusinesses && !ctx.cfg.businesses.autoBuildEnabled) {
    return json({ error: "auto-build not enabled for this project" }, 409);
  }
  void ctx.queue.log({
    topic: "business",
    kind: "auto_build.manual_trigger",
    userId: user.id,
    data: { project: r.project },
  });
  // Scoped to the requesting project — clicking "Auto-build" in project A
  // must not also trigger builds for unrelated opt-in projects B and C.
  // Auto-build is bounded by cfg.businesses.autoBuildBatchSize so this
  // inline run is safe.
  await runBusinessAutoBuild({
    db: ctx.db,
    queue: ctx.queue,
    cfg: ctx.cfg,
    onlyProject: r.project,
  });
  return json({ ok: true });
}

// ── Edit + Ask modes (mirror contact routes) ───────────────────────────────

async function handleEdit(
  req: Request,
  ctx: BusinessRouteCtx,
  user: User,
  rawProject: string,
): Promise<Response> {
  const r = resolveProject(ctx, user, rawProject);
  if (!r.ok) return r.error;
  const body = await readJson<{ prompt?: string; businessesSummary?: string }>(
    req,
  );
  if (!body) return json({ error: "invalid json" }, 400);
  const prompt = body.prompt?.trim();
  if (!prompt) return json({ error: "missing prompt" }, 400);
  const summary = body.businessesSummary ?? "";
  const sessionId = `business-edit-${crypto.randomUUID()}`;
  const userPrompt = summary
    ? `Current businesses:\n${summary}\n\nInstruction: ${prompt}`
    : prompt;
  setSessionHiddenFromChat(ctx.db, user.id, sessionId, true);
  void ctx.queue.log({
    topic: "business",
    kind: "edit",
    userId: user.id,
    data: { project: r.project, prompt },
  });
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const sink = controllerSink(controller);
      const renderer = createSseRenderer(sink);
      try {
        await runAgent({
          prompt: userPrompt,
          sessionId,
          userId: user.id,
          project: r.project,
          llmCfg: ctx.cfg.llm,
          embedCfg: ctx.cfg.embed,
          memoryCfg: ctx.cfg.memory,
          agentCfg: ctx.cfg.agent,
          webCfg: ctx.cfg.web,
          tools: toolsRegistry,
          db: ctx.db,
          queue: ctx.queue,
          renderer,
          // Reuse contact.edit prompt key by default; admins can override
          // both via the prompt registry. Business-specific prompt for v2.
          systemPromptOverride: resolvePrompt("contact.edit", {
            project: r.project,
          }),
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
    },
  });
}

async function handleAsk(
  req: Request,
  ctx: BusinessRouteCtx,
  user: User,
  rawProject: string,
): Promise<Response> {
  const r = resolveProject(ctx, user, rawProject);
  if (!r.ok) return r.error;
  const body = await readJson<{ prompt?: string; businessesSummary?: string }>(
    req,
  );
  if (!body) return json({ error: "invalid json" }, 400);
  const prompt = body.prompt?.trim();
  if (!prompt) return json({ error: "missing prompt" }, 400);
  const summary = body.businessesSummary ?? "";
  const sessionId = crypto.randomUUID();
  const fullPrompt = summary
    ? `[Businesses Summary]\n\n${summary}\n\n${prompt}`
    : prompt;
  setSessionQuickChat(ctx.db, user.id, sessionId, true);
  void ctx.queue.log({
    topic: "business",
    kind: "ask",
    userId: user.id,
    data: { project: r.project, prompt, sessionId },
  });
  return json({
    sessionId,
    project: r.project,
    prompt: fullPrompt,
    isQuickChat: true,
  });
}
