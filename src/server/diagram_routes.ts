import type { Database } from "bun:sqlite";
import type { User } from "../auth/users.ts";
import type { BunnyConfig } from "../config.ts";
import type { BunnyQueue } from "../queue/bunqueue.ts";
import { errorMessage } from "../util/error.ts";
import { json, readJson } from "./http.ts";
import { canSeeProject, canEditProject } from "./routes.ts";
import { requireProjectAccess } from "./route_helpers.ts";
import { getProject } from "../memory/projects.ts";
import { recordVersion } from "../memory/versioning.ts";
import {
  canEditDiagram,
  createDiagram,
  deleteDiagram,
  getDiagram,
  listDiagrams,
  updateDiagram,
} from "../memory/diagrams.ts";
import {
  createLibraryItem,
  deleteLibraryItem,
  getLibraryItem,
  listLibraryForProject,
} from "../memory/diagram_node_library.ts";
import { setSessionHiddenFromChat } from "../memory/session_visibility.ts";
import { runAgent } from "../agent/loop.ts";
import {
  createSseRenderer,
  controllerSink,
  finishSse,
} from "../agent/render_sse.ts";
import { registry as toolsRegistry } from "../tools/index.ts";
import { resolvePrompt } from "../prompts/resolve.ts";

export interface DiagramRouteCtx {
  db: Database;
  queue: BunnyQueue;
  cfg: BunnyConfig;
}

export async function handleDiagramRoute(
  req: Request,
  url: URL,
  ctx: DiagramRouteCtx,
  user: User,
): Promise<Response | null> {
  const { pathname } = url;

  // ── Library generate (must come before the library list/create match) ───────
  const libGenMatch = pathname.match(
    /^\/api\/projects\/([^/]+)\/diagrams\/library\/generate$/,
  );
  if (libGenMatch) {
    const project = decodeURIComponent(libGenMatch[1]!);
    if (req.method === "POST") return handleGenerateNode(req, ctx, user, project);
  }

  // ── List / create diagrams ──────────────────────────────────────────────────
  const listMatch = pathname.match(/^\/api\/projects\/([^/]+)\/diagrams$/);
  if (listMatch) {
    const project = decodeURIComponent(listMatch[1]!);
    if (req.method === "GET") return handleList(ctx, user, project);
    if (req.method === "POST") return handleCreate(req, ctx, user, project);
  }

  // ── Node library list / create ──────────────────────────────────────────────
  const libMatch = pathname.match(
    /^\/api\/projects\/([^/]+)\/diagrams\/library$/,
  );
  if (libMatch) {
    const project = decodeURIComponent(libMatch[1]!);
    if (req.method === "GET") return handleListLibrary(ctx, user, project, url);
    if (req.method === "POST") return handleCreateLibraryItem(req, ctx, user, project);
  }

  // ── Delete library item ──────────────────────────────────────────────────────
  const libIdMatch = pathname.match(/^\/api\/diagrams\/library\/(\d+)$/);
  if (libIdMatch) {
    const id = Number(libIdMatch[1]);
    if (req.method === "DELETE") return handleDeleteLibraryItem(ctx, user, id);
  }

  // ── Generate / edit / ask ────────────────────────────────────────────────────
  const generateMatch = pathname.match(/^\/api\/diagrams\/(\d+)\/generate$/);
  if (generateMatch) {
    const id = Number(generateMatch[1]);
    if (req.method === "POST") return handleGenerate(req, ctx, user, id);
  }

  const editMatch = pathname.match(/^\/api\/diagrams\/(\d+)\/edit$/);
  if (editMatch) {
    const id = Number(editMatch[1]);
    if (req.method === "POST") return handleEdit(req, ctx, user, id);
  }

  const askMatch = pathname.match(/^\/api\/diagrams\/(\d+)\/ask$/);
  if (askMatch) {
    const id = Number(askMatch[1]);
    if (req.method === "POST") return handleAsk(req, ctx, user, id);
  }

  // ── Get / patch / delete diagram ─────────────────────────────────────────────
  const idMatch = pathname.match(/^\/api\/diagrams\/(\d+)$/);
  if (idMatch) {
    const id = Number(idMatch[1]);
    if (req.method === "GET") return handleGet(ctx, user, id);
    if (req.method === "PATCH") return handlePatch(req, ctx, user, id);
    if (req.method === "DELETE") return handleDelete(ctx, user, id);
  }

  return null;
}

// ── Handlers ──────────────────────────────────────────────────────────────────

function handleList(
  ctx: DiagramRouteCtx,
  user: User,
  rawProject: string,
): Response {
  const access = requireProjectAccess(ctx.db, user, rawProject, "view");
  if (!access.ok) return access.response;
  return json({ diagrams: listDiagrams(ctx.db, access.project) });
}

async function handleCreate(
  req: Request,
  ctx: DiagramRouteCtx,
  user: User,
  rawProject: string,
): Promise<Response> {
  const access = requireProjectAccess(ctx.db, user, rawProject, "view");
  if (!access.ok) return access.response;
  const { project } = access;

  const body = await readJson<{
    name?: string;
    diagramType?: string;
    description?: string;
  }>(req);
  const name = body?.name?.trim();
  if (!name) return json({ error: "missing name" }, 400);

  try {
    const diagram = createDiagram(ctx.db, {
      project,
      name,
      diagramType: body?.diagramType,
      description: body?.description,
      createdBy: user.id,
    });
    recordVersion(ctx.db, "diagram", diagram.id, "save", user.id);
    void ctx.queue.log({
      topic: "diagram",
      kind: "create",
      userId: user.id,
      data: { id: diagram.id, project, name },
    });
    return json({ diagram }, 201);
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

function handleGet(ctx: DiagramRouteCtx, user: User, id: number): Response {
  const diagram = getDiagram(ctx.db, id);
  if (!diagram) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, diagram.project);
  if (!p || !canSeeProject(p, user)) return json({ error: "forbidden" }, 403);
  return json({ diagram });
}

async function handlePatch(
  req: Request,
  ctx: DiagramRouteCtx,
  user: User,
  id: number,
): Promise<Response> {
  const diagram = getDiagram(ctx.db, id);
  if (!diagram) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, diagram.project);
  if (!p) return json({ error: "project not found" }, 404);
  if (!canEditDiagram(user, diagram, p)) return json({ error: "forbidden" }, 403);

  const body = await readJson<{
    name?: string;
    description?: string;
    contentJson?: string;
    thumbnail?: string | null;
  }>(req);
  if (!body) return json({ error: "invalid json" }, 400);

  try {
    const updated = updateDiagram(ctx.db, id, {
      name: body.name,
      description: body.description,
      contentJson: body.contentJson,
      thumbnail: body.thumbnail,
    });
    recordVersion(ctx.db, "diagram", id, "save", user.id);
    void ctx.queue.log({
      topic: "diagram",
      kind: "update",
      userId: user.id,
      data: { id, project: diagram.project },
    });
    return json({ diagram: updated });
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

function handleDelete(
  ctx: DiagramRouteCtx,
  user: User,
  id: number,
): Response {
  const diagram = getDiagram(ctx.db, id);
  if (!diagram) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, diagram.project);
  if (!p) return json({ error: "project not found" }, 404);
  if (!canEditDiagram(user, diagram, p)) return json({ error: "forbidden" }, 403);

  deleteDiagram(ctx.db, id, user.id);
  void ctx.queue.log({
    topic: "diagram",
    kind: "delete",
    userId: user.id,
    data: { id, project: diagram.project, name: diagram.name, soft: true },
  });
  return json({ ok: true });
}

// ── Library handlers ──────────────────────────────────────────────────────────

function handleListLibrary(
  ctx: DiagramRouteCtx,
  user: User,
  rawProject: string,
  url: URL,
): Response {
  const access = requireProjectAccess(ctx.db, user, rawProject, "view");
  if (!access.ok) return access.response;
  const diagramType = url.searchParams.get("type") ?? undefined;
  return json({
    items: listLibraryForProject(ctx.db, access.project, diagramType),
  });
}

async function handleCreateLibraryItem(
  req: Request,
  ctx: DiagramRouteCtx,
  user: User,
  rawProject: string,
): Promise<Response> {
  const access = requireProjectAccess(ctx.db, user, rawProject, "view");
  if (!access.ok) return access.response;
  const { project } = access;

  const body = await readJson<{
    diagramType?: string;
    name?: string;
    description?: string;
    shape?: string;
    iconName?: string | null;
    color?: string;
    width?: number;
    height?: number;
    handleSides?: string[];
  }>(req);
  if (!body?.diagramType || !body.name?.trim()) {
    return json({ error: "missing diagramType or name" }, 400);
  }

  try {
    const item = createLibraryItem(ctx.db, {
      project,
      diagramType: body.diagramType,
      name: body.name,
      description: body.description,
      shape: body.shape,
      iconName: body.iconName,
      color: body.color,
      width: body.width,
      height: body.height,
      handleSides: body.handleSides,
      createdBy: user.id,
    });
    void ctx.queue.log({
      topic: "diagram",
      kind: "library.create",
      userId: user.id,
      data: { id: item.id, project, diagramType: body.diagramType, name: body.name },
    });
    return json({ item }, 201);
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

function handleDeleteLibraryItem(
  ctx: DiagramRouteCtx,
  user: User,
  id: number,
): Response {
  const item = getLibraryItem(ctx.db, id);
  if (!item) return json({ error: "not found" }, 404);
  if (item.isSeeded) return json({ error: "cannot delete seeded library items" }, 403);
  if (!item.project) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, item.project);
  if (!p || !canEditProject(p, user)) return json({ error: "forbidden" }, 403);

  deleteLibraryItem(ctx.db, id);
  void ctx.queue.log({
    topic: "diagram",
    kind: "library.delete",
    userId: user.id,
    data: { id, project: item.project },
  });
  return json({ ok: true });
}

// ── LLM generate (initial layout) ─────────────────────────────────────────────

async function handleGenerate(
  req: Request,
  ctx: DiagramRouteCtx,
  user: User,
  id: number,
): Promise<Response> {
  const diagram = getDiagram(ctx.db, id);
  if (!diagram) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, diagram.project);
  if (!p) return json({ error: "project not found" }, 404);
  if (!canEditDiagram(user, diagram, p)) return json({ error: "forbidden" }, 403);

  const body = await readJson<{ intent?: string }>(req);
  const intent = body?.intent?.trim() ?? "";

  const libraryItems = listLibraryForProject(
    ctx.db,
    diagram.project,
    diagram.diagramType,
  );

  const sessionId = `diag-gen-${crypto.randomUUID()}`;
  setSessionHiddenFromChat(ctx.db, user.id, sessionId, true);

  const userPrompt =
    `Diagram type: ${diagram.diagramType}\nIntent: ${intent}\n\nAvailable library nodes:\n\`\`\`json\n${JSON.stringify(libraryItems, null, 2)}\n\`\`\`\n\nGenerate the initial diagram layout.`;

  void ctx.queue.log({
    topic: "diagram",
    kind: "generate",
    userId: user.id,
    data: { id, project: diagram.project, intent: intent.slice(0, 200) },
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
          project: diagram.project,
          llmCfg: ctx.cfg.llm,
          embedCfg: ctx.cfg.embed,
          memoryCfg: ctx.cfg.memory,
          agentCfg: ctx.cfg.agent,
          tools: toolsRegistry,
          db: ctx.db,
          queue: ctx.queue,
          renderer,
          systemPromptOverride: resolvePrompt("diagram.generate", {
            project: diagram.project,
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
      "X-Diagram-Id": String(id),
    },
  });
}

// ── LLM edit (chat-driven) ────────────────────────────────────────────────────

async function handleEdit(
  req: Request,
  ctx: DiagramRouteCtx,
  user: User,
  id: number,
): Promise<Response> {
  const diagram = getDiagram(ctx.db, id);
  if (!diagram) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, diagram.project);
  if (!p) return json({ error: "project not found" }, 404);
  if (!canEditDiagram(user, diagram, p)) return json({ error: "forbidden" }, 403);

  const body = await readJson<{ prompt?: string; contentJson?: string }>(req);
  if (!body) return json({ error: "invalid json" }, 400);

  const prompt = body.prompt?.trim();
  if (!prompt) return json({ error: "missing prompt" }, 400);
  if (!body.contentJson) return json({ error: "missing contentJson" }, 400);

  const sessionId = `diag-edit-${crypto.randomUUID()}`;
  setSessionHiddenFromChat(ctx.db, user.id, sessionId, true);

  const userPrompt =
    `Current diagram JSON:\n\`\`\`json\n${body.contentJson}\n\`\`\`\n\nInstruction: ${prompt}`;

  void ctx.queue.log({
    topic: "diagram",
    kind: "edit",
    userId: user.id,
    data: { id, project: diagram.project, prompt },
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
          project: diagram.project,
          llmCfg: ctx.cfg.llm,
          embedCfg: ctx.cfg.embed,
          memoryCfg: ctx.cfg.memory,
          agentCfg: ctx.cfg.agent,
          tools: toolsRegistry,
          db: ctx.db,
          queue: ctx.queue,
          renderer,
          systemPromptOverride: resolvePrompt("diagram.edit", {
            project: diagram.project,
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
      "X-Diagram-Id": String(id),
    },
  });
}

// ── Question mode ──────────────────────────────────────────────────────────────

async function handleAsk(
  req: Request,
  ctx: DiagramRouteCtx,
  user: User,
  id: number,
): Promise<Response> {
  const diagram = getDiagram(ctx.db, id);
  if (!diagram) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, diagram.project);
  if (!p) return json({ error: "project not found" }, 404);
  if (!canSeeProject(p, user)) return json({ error: "forbidden" }, 403);

  const body = await readJson<{
    prompt?: string;
    contentJson?: string;
    thumbnail?: string;
  }>(req);
  if (!body) return json({ error: "invalid json" }, 400);

  const prompt = body.prompt?.trim();
  if (!prompt) return json({ error: "missing prompt" }, 400);

  if (body.contentJson || body.thumbnail) {
    updateDiagram(ctx.db, id, {
      contentJson: body.contentJson,
      thumbnail: body.thumbnail,
    });
    recordVersion(ctx.db, "diagram", id, "save", user.id);
  }

  const sessionId = crypto.randomUUID();
  const fullPrompt = `The user is asking about the diagram "${diagram.name}" (type: ${diagram.diagramType}). The current diagram content is attached.\n\nQuestion: ${prompt}`;

  void ctx.queue.log({
    topic: "diagram",
    kind: "ask",
    userId: user.id,
    data: { id, project: diagram.project, prompt, sessionId },
  });

  return json({ sessionId, project: diagram.project, prompt: fullPrompt, isQuickChat: true });
}

// ── LLM generate library node ─────────────────────────────────────────────────

async function handleGenerateNode(
  req: Request,
  ctx: DiagramRouteCtx,
  user: User,
  rawProject: string,
): Promise<Response> {
  const access = requireProjectAccess(ctx.db, user, rawProject, "view");
  if (!access.ok) return access.response;
  const { project } = access;

  const body = await readJson<{ diagramType?: string; request?: string }>(req);
  const diagramType = body?.diagramType?.trim();
  const request = body?.request?.trim();
  if (!diagramType || !request) {
    return json({ error: "missing diagramType or request" }, 400);
  }

  const sessionId = `diag-nodelib-${crypto.randomUUID()}`;
  setSessionHiddenFromChat(ctx.db, user.id, sessionId, true);

  const userPrompt = `Diagram type: ${diagramType}\nRequest: ${request}`;

  void ctx.queue.log({
    topic: "diagram",
    kind: "library.generate",
    userId: user.id,
    data: { project, diagramType, request },
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
          project,
          llmCfg: ctx.cfg.llm,
          embedCfg: ctx.cfg.embed,
          memoryCfg: ctx.cfg.memory,
          agentCfg: ctx.cfg.agent,
          tools: toolsRegistry,
          db: ctx.db,
          queue: ctx.queue,
          renderer,
          systemPromptOverride: resolvePrompt("diagram.node.generate", {
            project,
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
