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
import {
  setSessionHiddenFromChat,
  setSessionQuickChat,
} from "../memory/session_visibility.ts";
import { runAgent } from "../agent/loop.ts";
import {
  createSseRenderer,
  controllerSink,
  finishSse,
} from "../agent/render_sse.ts";
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

function handleList(
  ctx: WhiteboardRouteCtx,
  user: User,
  rawProject: string,
): Response {
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

function handleDelete(
  ctx: WhiteboardRouteCtx,
  user: User,
  id: number,
): Response {
  const wb = getWhiteboard(ctx.db, id);
  if (!wb) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, wb.project);
  if (!p) return json({ error: "project not found" }, 404);
  if (!canEditWhiteboard(user, wb, p)) return json({ error: "forbidden" }, 403);

  deleteWhiteboard(ctx.db, id, user.id);
  void ctx.queue.log({
    topic: "whiteboard",
    kind: "delete",
    userId: user.id,
    data: { id, project: wb.project, name: wb.name, soft: true },
  });
  return json({ ok: true });
}

// ── Edit mode (agent loop) ──────────────────────────────────────────────

const EDIT_SYSTEM_PROMPT = `You are an expert Excalidraw whiteboard editor. The user will provide:
1. A screenshot of the current whiteboard (optional)
2. The current Excalidraw elements JSON array
3. An instruction describing what to change

Your task: modify the elements JSON according to the instruction and return the complete, updated elements array.

## Output Contract
- Return ONLY a JSON code block with the complete elements array. No other text.
- Preserve existing element IDs when modifying elements.
- When adding new elements, generate unique IDs (random alphanumeric strings).

## Design Philosophy
Diagrams should ARGUE, not DISPLAY. A diagram is a visual argument showing relationships, causality, and flow that words alone cannot express. The shape should BE the meaning.

**Isomorphism Test**: If you removed all text, would the structure alone communicate the concept? If not, redesign.

**Container Discipline**: Default to free-floating text. Add containers only when they serve a purpose:
- Use a container when: it's a focal point, needs visual grouping, arrows connect to it, or the shape carries meaning.
- Use free-floating text when: it's a label, description, supporting detail, or section title.
- Aim for <30% of text elements inside containers. Typography (size, weight, color) creates hierarchy without boxes.

## Visual Pattern Mapping
Choose the pattern that mirrors the concept's behavior:

| If the concept... | Use this pattern |
|-------------------|------------------|
| Spawns multiple outputs | Fan-out (radial arrows from center) |
| Combines inputs into one | Convergence (arrows merging) |
| Has hierarchy/nesting | Tree (lines + free-floating text) |
| Is a sequence of steps | Timeline (line + dots + labels) |
| Loops or improves | Spiral/Cycle (arrow returning to start) |
| Is an abstract state | Cloud (overlapping ellipses) |
| Transforms input→output | Assembly line (before → process → after) |
| Compares two things | Side-by-side (parallel with contrast) |
| Separates into phases | Gap/Break (visual separation) |

For multi-concept diagrams, each major concept should use a different visual pattern.

## Shape Meaning
| Concept Type | Shape |
|--------------|-------|
| Labels, descriptions | none (free-floating text) |
| Timeline markers | small ellipse (10-20px) |
| Start, trigger, input | ellipse (use green-tinted fill) |
| End, output, result | rectangle with rounded corners (use blue-tinted fill) |
| Decision, condition | diamond |
| Process, action, step | rectangle |
| Abstract state | overlapping ellipses |
| Hierarchy node | lines + text (no boxes) |

## Color & Layout
- Colors encode meaning, not decoration. Each semantic purpose gets a distinct fill/stroke pair.
- Always pair a darker stroke with a lighter fill for contrast.
- **Scale hierarchy**: Hero 300×150, Primary 180×90, Secondary 120×60, Small 60×40.
- **Flow direction**: Left→right or top→bottom for sequences, radial for hub-and-spoke.
- **Connections required**: If A relates to B, there must be an arrow.

## Element Requirements
Types: rectangle, ellipse, diamond, text, arrow, line, freedraw, image.

Minimum properties: id, type, x, y, width, height, strokeColor, backgroundColor, fillStyle, strokeWidth, roughness, opacity, seed, version, versionNonce, angle, isDeleted, boundElements, link, locked.
- roughness: 0 for clean/modern (default), 1 for hand-drawn/informal.
- strokeWidth: 1 thin, 2 standard (default), 3 bold emphasis.
- opacity: always 100.
- When modifying existing elements, preserve seed/version/versionNonce. For new elements, use random seed and version=1.

Text elements also need: text, fontSize, fontFamily (always 3 = monospace), textAlign, verticalAlign.
- CRITICAL: the text property contains ONLY readable words, nothing else.

Arrows/lines also need: points array with [x, y] coordinates.

**boundElements**: When text is inside a shape, add the text element's id to the shape's boundElements array as \`{"id":"textId","type":"text"}\` and set the text element's containerId to the shape's id. When an arrow connects to a shape, add the arrow's id to the shape's boundElements as \`{"id":"arrowId","type":"arrow"}\`. Arrows use startBinding/endBinding with \`{"elementId":"shapeId","focus":0,"gap":1}\`.

Defaults: strokeColor="#1e1e1e", backgroundColor="transparent", fillStyle="solid", strokeWidth=2, roughness=0, opacity=100.

Example rectangle with bound text:
\`\`\`json
[{"id":"rect1","type":"rectangle","x":100,"y":100,"width":200,"height":100,"strokeColor":"#1e1e1e","backgroundColor":"transparent","fillStyle":"solid","strokeWidth":2,"roughness":0,"opacity":100,"seed":12345,"version":1,"versionNonce":1,"angle":0,"isDeleted":false,"boundElements":[{"id":"text1","type":"text"}],"link":null,"locked":false},{"id":"text1","type":"text","x":120,"y":130,"width":160,"height":40,"strokeColor":"#1e1e1e","backgroundColor":"transparent","fillStyle":"solid","strokeWidth":0,"roughness":0,"opacity":100,"seed":67890,"version":1,"versionNonce":1,"angle":0,"isDeleted":false,"boundElements":null,"link":null,"locked":false,"text":"Process","originalText":"Process","fontSize":20,"fontFamily":3,"textAlign":"center","verticalAlign":"middle","containerId":"rect1"}]
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
  if (
    body.screenshotDataUrl &&
    body.screenshotDataUrl.length > MAX_SCREENSHOT_BYTES
  ) {
    return json({ error: "screenshot exceeds size limit" }, 413);
  }

  const sessionId = `wb-edit-${randomUUID()}`;

  const userPrompt = `Current Excalidraw elements JSON:\n\`\`\`json\n${body.elementsJson}\n\`\`\`\n\nInstruction: ${prompt}`;

  const attachments = body.screenshotDataUrl
    ? [
        {
          kind: "image" as const,
          mime: "image/png",
          dataUrl: body.screenshotDataUrl,
        },
      ]
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
          webCfg: ctx.cfg.web,
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

  // The screenshot PNG is attached client-side (it's already in-memory
  // there) — see WhiteboardTab.handleSend. This endpoint only persists the
  // canvas state + primes the session.
  const fullPrompt = `The user is asking about the whiteboard "${wb.name}". The image of the whiteboard is attached.\n\nQuestion: ${prompt}`;

  setSessionQuickChat(ctx.db, user.id, sessionId, true);

  void ctx.queue.log({
    topic: "whiteboard",
    kind: "ask",
    userId: user.id,
    data: { id, project: wb.project, prompt, sessionId },
  });

  return json({
    sessionId,
    project: wb.project,
    prompt: fullPrompt,
    isQuickChat: true,
  });
}
