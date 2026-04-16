import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { User } from "../auth/users.ts";
import type { BunnyConfig } from "../config.ts";
import type { BunnyQueue } from "../queue/bunqueue.ts";
import { errorMessage } from "../util/error.ts";
import { json, readJson } from "./http.ts";
import { canSeeProject, canEditProject } from "./routes.ts";
import { getProject, validateProjectName } from "../memory/projects.ts";
import {
  canEditWhiteboard,
  createWhiteboard,
  deleteWhiteboard,
  getWhiteboard,
  listWhiteboards,
  updateWhiteboard,
} from "../memory/whiteboards.ts";
import { setSessionHiddenFromChat } from "../memory/session_visibility.ts";
import { insertMessage } from "../memory/messages.ts";
import { runAgent } from "../agent/loop.ts";
import { createSseRenderer, controllerSink, finishSse } from "../agent/render_sse.ts";
import { registry as toolsRegistry } from "../tools/index.ts";

export interface WhiteboardRouteCtx {
  db: Database;
  queue: BunnyQueue;
  cfg: BunnyConfig;
}

export async function handleWhiteboardRoute(
  req: Request,
  url: URL,
  ctx: WhiteboardRouteCtx,
  user: User,
): Promise<Response | null> {
  const { pathname } = url;

  const listMatch = pathname.match(/^\/api\/projects\/([^/]+)\/whiteboards$/);
  if (listMatch) {
    const project = decodeURIComponent(listMatch[1]!);
    if (req.method === "GET") return handleList(ctx, user, project);
    if (req.method === "POST") return handleCreate(req, ctx, user, project);
  }

  const idMatch = pathname.match(/^\/api\/whiteboards\/(\d+)$/);
  if (idMatch) {
    const id = Number(idMatch[1]);
    if (req.method === "GET") return handleGet(ctx, user, id);
    if (req.method === "PATCH") return handlePatch(req, ctx, user, id);
    if (req.method === "DELETE") return handleDelete(ctx, user, id);
  }

  const editMatch = pathname.match(/^\/api\/whiteboards\/(\d+)\/edit$/);
  if (editMatch) {
    const id = Number(editMatch[1]);
    if (req.method === "POST") return handleEdit(req, ctx, user, id);
  }

  const askMatch = pathname.match(/^\/api\/whiteboards\/(\d+)\/ask$/);
  if (askMatch) {
    const id = Number(askMatch[1]);
    if (req.method === "POST") return handleAsk(req, ctx, user, id);
  }

  return null;
}

// ── Handlers ──────────────────────────────────────────────────────────────

function handleList(ctx: WhiteboardRouteCtx, user: User, rawProject: string): Response {
  let project: string;
  try {
    project = validateProjectName(rawProject);
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
  const p = getProject(ctx.db, project);
  if (!p) return json({ error: "project not found" }, 404);
  if (!canSeeProject(p, user)) return json({ error: "forbidden" }, 403);
  return json({ whiteboards: listWhiteboards(ctx.db, project) });
}

async function handleCreate(
  req: Request,
  ctx: WhiteboardRouteCtx,
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
  if (!canSeeProject(p, user)) return json({ error: "forbidden" }, 403);

  const body = await readJson<{ name?: string }>(req);
  const name = body?.name?.trim();
  if (!name) return json({ error: "missing name" }, 400);

  try {
    const wb = createWhiteboard(ctx.db, { project, name, createdBy: user.id });
    void ctx.queue.log({
      topic: "whiteboard",
      kind: "create",
      userId: user.id,
      data: { id: wb.id, project, name },
    });
    return json({ whiteboard: wb }, 201);
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

function handleGet(ctx: WhiteboardRouteCtx, user: User, id: number): Response {
  const wb = getWhiteboard(ctx.db, id);
  if (!wb) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, wb.project);
  if (!p || !canSeeProject(p, user)) return json({ error: "forbidden" }, 403);
  return json({ whiteboard: wb });
}

async function handlePatch(
  req: Request,
  ctx: WhiteboardRouteCtx,
  user: User,
  id: number,
): Promise<Response> {
  const wb = getWhiteboard(ctx.db, id);
  if (!wb) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, wb.project);
  if (!p) return json({ error: "project not found" }, 404);
  if (!canEditWhiteboard(user, wb, p)) return json({ error: "forbidden" }, 403);

  const body = await readJson<{
    name?: string;
    elementsJson?: string;
    appStateJson?: string | null;
    thumbnail?: string | null;
  }>(req);
  if (!body) return json({ error: "invalid json" }, 400);

  try {
    const updated = updateWhiteboard(ctx.db, id, {
      name: body.name,
      elementsJson: body.elementsJson,
      appStateJson: body.appStateJson,
      thumbnail: body.thumbnail,
    });
    void ctx.queue.log({
      topic: "whiteboard",
      kind: "update",
      userId: user.id,
      data: { id, project: wb.project },
    });
    return json({ whiteboard: updated });
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

function handleDelete(ctx: WhiteboardRouteCtx, user: User, id: number): Response {
  const wb = getWhiteboard(ctx.db, id);
  if (!wb) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, wb.project);
  if (!p) return json({ error: "project not found" }, 404);
  if (!canEditWhiteboard(user, wb, p)) return json({ error: "forbidden" }, 403);

  deleteWhiteboard(ctx.db, id);
  void ctx.queue.log({
    topic: "whiteboard",
    kind: "delete",
    userId: user.id,
    data: { id, project: wb.project, name: wb.name },
  });
  return json({ ok: true });
}

// ── Edit mode (agent loop) ──────────────────────────────────────────────

const EDIT_SYSTEM_PROMPT = `You are an Excalidraw whiteboard editor. The user will provide:
1. A screenshot of the current whiteboard
2. The current Excalidraw elements JSON array
3. An instruction describing what to change

Your task: modify the elements JSON according to the instruction and return the complete, updated elements array.

Rules:
- Return ONLY a JSON code block with the complete elements array. No other text.
- Preserve existing element IDs when modifying elements.
- When adding new elements, generate unique IDs (use random alphanumeric strings).
- Excalidraw element types: rectangle, ellipse, diamond, text, arrow, line, freedraw, image.
- Each element must have at minimum: id, type, x, y, width, height, strokeColor, backgroundColor, fillStyle, strokeWidth, roughness, opacity, seed, version, versionNonce.
- For text elements, also include: text, fontSize, fontFamily, textAlign, verticalAlign.
- For arrows/lines: include points array with [x, y] coordinates.
- Use reasonable defaults: strokeColor="#1e1e1e", backgroundColor="transparent", fillStyle="solid", strokeWidth=2, roughness=1, opacity=100.

Example element:
\`\`\`json
{"id":"abc123","type":"rectangle","x":100,"y":100,"width":200,"height":100,"strokeColor":"#1e1e1e","backgroundColor":"transparent","fillStyle":"solid","strokeWidth":2,"roughness":1,"opacity":100,"seed":12345,"version":1,"versionNonce":1,"angle":0,"isDeleted":false,"boundElements":null,"link":null,"locked":false}
\`\`\`

Return the full elements array wrapped in a JSON code block:
\`\`\`json
[...elements...]
\`\`\``;

async function handleEdit(
  req: Request,
  ctx: WhiteboardRouteCtx,
  user: User,
  id: number,
): Promise<Response> {
  const wb = getWhiteboard(ctx.db, id);
  if (!wb) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, wb.project);
  if (!p) return json({ error: "project not found" }, 404);
  if (!canEditWhiteboard(user, wb, p)) return json({ error: "forbidden" }, 403);

  const body = await readJson<{
    prompt?: string;
    elementsJson?: string;
    screenshotDataUrl?: string;
  }>(req);
  if (!body) return json({ error: "invalid json" }, 400);

  const prompt = body.prompt?.trim();
  if (!prompt) return json({ error: "missing prompt" }, 400);
  if (!body.elementsJson) return json({ error: "missing elementsJson" }, 400);

  const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;
  if (body.screenshotDataUrl && body.screenshotDataUrl.length > MAX_SCREENSHOT_BYTES) {
    return json({ error: "screenshot exceeds size limit" }, 413);
  }

  const sessionId = `wb-edit-${randomUUID()}`;

  const userPrompt = `Current Excalidraw elements JSON:\n\`\`\`json\n${body.elementsJson}\n\`\`\`\n\nInstruction: ${prompt}`;

  const attachments = body.screenshotDataUrl
    ? [{ kind: "image" as const, mime: "image/png", dataUrl: body.screenshotDataUrl }]
    : [];

  setSessionHiddenFromChat(ctx.db, user.id, sessionId, true);

  void ctx.queue.log({
    topic: "whiteboard",
    kind: "edit",
    userId: user.id,
    data: { id, project: wb.project, prompt },
  });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const sink = controllerSink(controller);
      const renderer = createSseRenderer(sink);

      try {
        await runAgent({
          prompt: userPrompt,
          attachments: attachments.length > 0 ? attachments : undefined,
          sessionId,
          userId: user.id,
          project: wb.project,
          llmCfg: ctx.cfg.llm,
          embedCfg: ctx.cfg.embed,
          memoryCfg: ctx.cfg.memory,
          agentCfg: ctx.cfg.agent,
          tools: toolsRegistry,
          db: ctx.db,
          queue: ctx.queue,
          renderer,
          systemPromptOverride: EDIT_SYSTEM_PROMPT,
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
      "X-Whiteboard-Id": String(id),
    },
  });
}

// ── Question mode ──────────────────────────────────────────────────────────

async function handleAsk(
  req: Request,
  ctx: WhiteboardRouteCtx,
  user: User,
  id: number,
): Promise<Response> {
  const wb = getWhiteboard(ctx.db, id);
  if (!wb) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, wb.project);
  if (!p) return json({ error: "project not found" }, 404);
  if (!canSeeProject(p, user)) return json({ error: "forbidden" }, 403);

  const body = await readJson<{
    prompt?: string;
    elementsJson?: string;
    screenshotDataUrl?: string;
    thumbnail?: string;
  }>(req);
  if (!body) return json({ error: "invalid json" }, 400);

  const prompt = body.prompt?.trim();
  if (!prompt) return json({ error: "missing prompt" }, 400);

  if (body.elementsJson || body.thumbnail) {
    updateWhiteboard(ctx.db, id, {
      elementsJson: body.elementsJson,
      thumbnail: body.thumbnail,
    });
  }

  const sessionId = randomUUID();

  const attachments = body.screenshotDataUrl
    ? [{ kind: "image" as const, mime: "image/png", dataUrl: body.screenshotDataUrl }]
    : [];

  const fullPrompt = `[Whiteboard: "${wb.name}"]\n\n${prompt}`;

  insertMessage(ctx.db, {
    sessionId,
    role: "user",
    channel: "content",
    content: fullPrompt,
    userId: user.id,
    project: wb.project,
    attachments,
  });

  void ctx.queue.log({
    topic: "whiteboard",
    kind: "ask",
    userId: user.id,
    data: { id, project: wb.project, prompt, sessionId },
  });

  return json({ sessionId, project: wb.project });
}

