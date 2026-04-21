/**
 * Knowledge Base routes — per-project definitions.
 *
 * Mirrors the contact / document route shape: project-scoped CRUD plus an SSE
 * generation endpoint that drives runAgent with a fixed systemPromptOverride.
 * The LLM is asked to return a single fenced JSON block with short / long /
 * sources which is then parsed and written back to the row.
 */

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { User } from "../auth/users.ts";
import type { BunnyConfig } from "../config.ts";
import type { BunnyQueue } from "../queue/bunqueue.ts";
import { errorMessage } from "../util/error.ts";
import { json, readJson } from "./http.ts";
import { canSeeProject } from "./routes.ts";
import { getProject, validateProjectName } from "../memory/projects.ts";
import type { Project } from "../memory/projects.ts";
import { setSessionHiddenFromChat } from "../memory/session_visibility.ts";
import { runAgent } from "../agent/loop.ts";
import {
  createSseRenderer,
  controllerSink,
  finishSse,
} from "../agent/render_sse.ts";
import type { SseEvent } from "../agent/sse_events.ts";
import { registry as toolsRegistry } from "../tools/index.ts";
import { resolvePrompt } from "../prompts/resolve.ts";
import {
  canEditDefinition,
  clearLlmFields,
  clearSvgFields,
  createDefinition,
  deleteDefinition,
  getDefinition,
  listDefinitions,
  setActiveDescription,
  setLlmError,
  setLlmGenerating,
  setLlmResult,
  setSvgError,
  setSvgGenerating,
  setSvgResult,
  updateDefinition,
  type ActiveDescription,
  type DefinitionSource,
} from "../memory/kb_definitions.ts";

const SSE_ENCODER = new TextEncoder();

export interface KbRouteCtx {
  db: Database;
  queue: BunnyQueue;
  cfg: BunnyConfig;
}

export async function handleKbRoute(
  req: Request,
  url: URL,
  ctx: KbRouteCtx,
  user: User,
): Promise<Response | null> {
  const { pathname } = url;

  const listMatch = pathname.match(
    /^\/api\/projects\/([^/]+)\/kb\/definitions$/,
  );
  if (listMatch) {
    const project = decodeURIComponent(listMatch[1]!);
    if (req.method === "GET") return handleList(ctx, user, project, url);
    if (req.method === "POST") return handleCreate(req, ctx, user, project);
  }

  const generateMatch = pathname.match(
    /^\/api\/projects\/([^/]+)\/kb\/definitions\/(\d+)\/generate$/,
  );
  if (generateMatch) {
    const project = decodeURIComponent(generateMatch[1]!);
    const id = Number(generateMatch[2]);
    if (req.method === "POST") return handleGenerate(ctx, user, project, id);
  }

  const clearMatch = pathname.match(
    /^\/api\/projects\/([^/]+)\/kb\/definitions\/(\d+)\/clear-llm$/,
  );
  if (clearMatch) {
    const project = decodeURIComponent(clearMatch[1]!);
    const id = Number(clearMatch[2]);
    if (req.method === "POST") return handleClearLlm(ctx, user, project, id);
  }

  const generateSvgMatch = pathname.match(
    /^\/api\/projects\/([^/]+)\/kb\/definitions\/(\d+)\/generate-illustration$/,
  );
  if (generateSvgMatch) {
    const project = decodeURIComponent(generateSvgMatch[1]!);
    const id = Number(generateSvgMatch[2]);
    if (req.method === "POST")
      return handleGenerateIllustration(ctx, user, project, id);
  }

  const clearSvgMatch = pathname.match(
    /^\/api\/projects\/([^/]+)\/kb\/definitions\/(\d+)\/clear-illustration$/,
  );
  if (clearSvgMatch) {
    const project = decodeURIComponent(clearSvgMatch[1]!);
    const id = Number(clearSvgMatch[2]);
    if (req.method === "POST")
      return handleClearIllustration(ctx, user, project, id);
  }

  const activeMatch = pathname.match(
    /^\/api\/projects\/([^/]+)\/kb\/definitions\/(\d+)\/active$/,
  );
  if (activeMatch) {
    const project = decodeURIComponent(activeMatch[1]!);
    const id = Number(activeMatch[2]);
    if (req.method === "POST")
      return handleSetActive(req, ctx, user, project, id);
  }

  const idMatch = pathname.match(
    /^\/api\/projects\/([^/]+)\/kb\/definitions\/(\d+)$/,
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

// ── Helpers ──────────────────────────────────────────────────────────────────

type ResolveOk = { ok: true; project: string; p: Project };
type ResolveErr = { ok: false; error: Response };
type ResolveResult = ResolveOk | ResolveErr;

function resolveProject(
  ctx: KbRouteCtx,
  user: User,
  rawProject: string,
): ResolveResult {
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

function loadDefinitionFor(
  ctx: KbRouteCtx,
  user: User,
  rawProject: string,
  id: number,
  requireEdit: boolean,
) {
  const r = resolveProject(ctx, user, rawProject);
  if (!r.ok) return r;
  const def = getDefinition(ctx.db, id);
  if (!def || def.project !== r.project) {
    return { ok: false as const, error: json({ error: "not found" }, 404) };
  }
  if (requireEdit && !canEditDefinition(user, def, r.p)) {
    return { ok: false as const, error: json({ error: "forbidden" }, 403) };
  }
  return { ok: true as const, project: r.project, p: r.p, def };
}

// ── List / create ────────────────────────────────────────────────────────────

function handleList(
  ctx: KbRouteCtx,
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
  return json(listDefinitions(ctx.db, r.project, { search, limit, offset }));
}

async function handleCreate(
  req: Request,
  ctx: KbRouteCtx,
  user: User,
  rawProject: string,
): Promise<Response> {
  const r = resolveProject(ctx, user, rawProject);
  if (!r.ok) return r.error;

  const body = await readJson<{
    term?: string;
    manualDescription?: string;
    isProjectDependent?: boolean;
    activeDescription?: ActiveDescription;
  }>(req);
  if (!body?.term?.trim()) return json({ error: "missing term" }, 400);

  try {
    const def = createDefinition(ctx.db, {
      project: r.project,
      term: body.term,
      manualDescription: body.manualDescription,
      isProjectDependent: body.isProjectDependent,
      activeDescription: body.activeDescription,
      createdBy: user.id,
    });
    void ctx.queue.log({
      topic: "kb",
      kind: "definition.create",
      userId: user.id,
      data: { id: def.id, project: r.project, term: def.term },
    });
    return json({ definition: def }, 201);
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

function handleGet(
  ctx: KbRouteCtx,
  user: User,
  rawProject: string,
  id: number,
): Response {
  const r = loadDefinitionFor(ctx, user, rawProject, id, false);
  if (!r.ok) return r.error;
  return json({ definition: r.def });
}

async function handlePatch(
  req: Request,
  ctx: KbRouteCtx,
  user: User,
  rawProject: string,
  id: number,
): Promise<Response> {
  const r = loadDefinitionFor(ctx, user, rawProject, id, true);
  if (!r.ok) return r.error;

  const body = await readJson<{
    term?: string;
    manualDescription?: string;
    isProjectDependent?: boolean;
    activeDescription?: ActiveDescription;
  }>(req);
  if (!body) return json({ error: "invalid json" }, 400);

  try {
    const updated = updateDefinition(ctx.db, id, body);
    void ctx.queue.log({
      topic: "kb",
      kind: "definition.update",
      userId: user.id,
      data: { id, project: r.project, changed: Object.keys(body) },
    });
    return json({ definition: updated });
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

function handleDelete(
  ctx: KbRouteCtx,
  user: User,
  rawProject: string,
  id: number,
): Response {
  const r = loadDefinitionFor(ctx, user, rawProject, id, true);
  if (!r.ok) return r.error;

  deleteDefinition(ctx.db, id, user.id);
  void ctx.queue.log({
    topic: "kb",
    kind: "definition.delete",
    userId: user.id,
    data: { id, project: r.project, term: r.def.term, soft: true },
  });
  return json({ ok: true });
}

// ── Active description picker ────────────────────────────────────────────────

async function handleSetActive(
  req: Request,
  ctx: KbRouteCtx,
  user: User,
  rawProject: string,
  id: number,
): Promise<Response> {
  const r = loadDefinitionFor(ctx, user, rawProject, id, true);
  if (!r.ok) return r.error;

  const body = await readJson<{ active?: ActiveDescription }>(req);
  if (!body?.active) return json({ error: "missing active" }, 400);

  try {
    const updated = setActiveDescription(ctx.db, id, body.active);
    void ctx.queue.log({
      topic: "kb",
      kind: "definition.active.set",
      userId: user.id,
      data: { id, project: r.project, active: body.active },
    });
    return json({ definition: updated });
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

// ── Clear LLM fields ─────────────────────────────────────────────────────────

function handleClearLlm(
  ctx: KbRouteCtx,
  user: User,
  rawProject: string,
  id: number,
): Response {
  const r = loadDefinitionFor(ctx, user, rawProject, id, true);
  if (!r.ok) return r.error;

  const updated = clearLlmFields(ctx.db, id);
  void ctx.queue.log({
    topic: "kb",
    kind: "definition.clear",
    userId: user.id,
    data: { id, project: r.project, term: r.def.term },
  });
  return json({ definition: updated });
}

// ── LLM generation (SSE) ─────────────────────────────────────────────────────

async function handleGenerate(
  ctx: KbRouteCtx,
  user: User,
  rawProject: string,
  id: number,
): Promise<Response> {
  const r = loadDefinitionFor(ctx, user, rawProject, id, true);
  if (!r.ok) return r.error;

  // Conditional flip to 'generating'. On lost race, 409 without touching the
  // queue or the agent loop.
  if (!setLlmGenerating(ctx.db, id)) {
    return json({ error: "generation already in progress" }, 409);
  }

  void ctx.queue.log({
    topic: "kb",
    kind: "definition.generate",
    userId: user.id,
    data: {
      id,
      project: r.project,
      term: r.def.term,
      projectDependent: r.def.isProjectDependent,
    },
  });

  const sessionId = `kb-def-${randomUUID()}`;
  setSessionHiddenFromChat(ctx.db, user.id, sessionId, true);

  const projectContext = (
    r.p.description?.trim() ? r.p.description.trim() : r.p.name
  ).trim();
  const userPrompt = r.def.isProjectDependent
    ? `Project: ${r.p.name}\nProject context: ${projectContext}\n\nDefine the term (blend with project context when forming search queries): "${r.def.term}"`
    : `Define the term: "${r.def.term}"`;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const sink = controllerSink(controller);
      const renderer = createSseRenderer(sink);

      let finalAnswer = "";
      try {
        finalAnswer = await runAgent({
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
          systemPromptOverride: resolvePrompt("kb.definition", {
            project: r.project,
          }),
        });

        const parsed = extractDefinitionJson(finalAnswer);
        if (!parsed) {
          setLlmError(ctx.db, id, "model did not return a valid JSON block");
          void ctx.queue.log({
            topic: "kb",
            kind: "definition.generate.parse_error",
            userId: user.id,
            data: { id, project: r.project, term: r.def.term },
          });
          renderer.onError(
            "Generation failed: model did not return valid JSON",
          );
        } else {
          setLlmResult(ctx.db, id, parsed);
          const ev: SseEvent = {
            type: "kb_definition_generated",
            definitionId: id,
            sources: parsed.sources.length,
          };
          sink.enqueue(SSE_ENCODER.encode(`data: ${JSON.stringify(ev)}\n\n`));
          void ctx.queue.log({
            topic: "kb",
            kind: "definition.generate.done",
            userId: user.id,
            data: {
              id,
              project: r.project,
              term: r.def.term,
              sources: parsed.sources.length,
            },
          });
        }
      } catch (e) {
        // Guarantee the row never stays 'generating' on a thrown path.
        const msg = errorMessage(e);
        try {
          setLlmError(ctx.db, id, msg);
        } catch {
          // swallow — DB may already be closed during test teardown
        }
        renderer.onError(msg);
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
      "X-Definition-Id": String(id),
    },
  });
}

/**
 * Extract the JSON payload from the LLM's final answer. Accepts either a
 * ```json``` fence, a bare ``` fence, or a raw JSON object — in that order.
 */
export function extractDefinitionJson(raw: string): {
  short: string;
  long: string;
  sources: DefinitionSource[];
} | null {
  const candidates: string[] = [];
  const fencedJson = raw.match(/```json\s*\n([\s\S]*?)\n```/);
  if (fencedJson?.[1]) candidates.push(fencedJson[1]);
  const fencedBare = raw.match(/```\s*\n([\s\S]*?)\n```/);
  if (fencedBare?.[1]) candidates.push(fencedBare[1]);
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(raw.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const obj = JSON.parse(candidate.trim());
      const short =
        typeof obj.shortDescription === "string"
          ? obj.shortDescription.trim()
          : "";
      const long =
        typeof obj.longDescription === "string"
          ? obj.longDescription.trim()
          : "";
      const sources: DefinitionSource[] = [];
      if (Array.isArray(obj.sources)) {
        for (const s of obj.sources) {
          if (
            s &&
            typeof s === "object" &&
            typeof s.title === "string" &&
            typeof s.url === "string"
          ) {
            const url = s.url.trim();
            if (/^https?:\/\//i.test(url)) {
              sources.push({ title: s.title.trim(), url });
            }
          }
        }
      }
      if (!short && !long && sources.length === 0) continue;
      return { short, long, sources };
    } catch {
      continue;
    }
  }

  return null;
}

// ── Illustration (SVG) generation (SSE) ──────────────────────────────────────

const ILLUSTRATION_MAX_BYTES = 200 * 1024;

const ILLUSTRATION_DESC_MAX = 1000;

function clip(s: string): string {
  return s.length > ILLUSTRATION_DESC_MAX
    ? `${s.slice(0, ILLUSTRATION_DESC_MAX)}…`
    : s;
}

function buildIllustrationPrompt(def: {
  term: string;
  manualDescription: string;
  llmShort: string | null;
  llmLong: string | null;
}): string {
  const parts: string[] = [
    `Please create a professional SVG illustration that purely visually shows what is meant by the following definition: "${def.term}".`,
    `The SVG must be clear and precise — verify everything is correct before returning it. Use as little text as possible; only use text where it is absolutely necessary for the explanation.`,
  ];
  const manual = def.manualDescription.trim();
  const short = def.llmShort?.trim();
  const long = def.llmLong?.trim();
  if (short) {
    parts.push(
      `The following is a short description that indicates what is meant by the definition: ${clip(short)}`,
    );
  }
  if (long) {
    parts.push(
      `The following is a longer description that indicates what is meant by the definition: ${clip(long)}`,
    );
  }
  if (manual) {
    parts.push(
      `The following is a manual description (written by the user) that indicates what is meant by the definition: ${clip(manual)}`,
    );
  }
  return parts.join("\n\n");
}

async function handleGenerateIllustration(
  ctx: KbRouteCtx,
  user: User,
  rawProject: string,
  id: number,
): Promise<Response> {
  const r = loadDefinitionFor(ctx, user, rawProject, id, true);
  if (!r.ok) return r.error;

  if (!setSvgGenerating(ctx.db, id)) {
    return json({ error: "illustration generation already in progress" }, 409);
  }

  void ctx.queue.log({
    topic: "kb",
    kind: "definition.illustration.generate",
    userId: user.id,
    data: { id, project: r.project, term: r.def.term },
  });

  const sessionId = `kb-svg-${randomUUID()}`;
  setSessionHiddenFromChat(ctx.db, user.id, sessionId, true);

  const userPrompt = buildIllustrationPrompt(r.def);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const sink = controllerSink(controller);
      const renderer = createSseRenderer(sink);

      let finalAnswer = "";
      try {
        finalAnswer = await runAgent({
          prompt: userPrompt,
          sessionId,
          userId: user.id,
          project: r.project,
          llmCfg: ctx.cfg.llm,
          embedCfg: ctx.cfg.embed,
          memoryCfg: ctx.cfg.memory,
          agentCfg: ctx.cfg.agent,
          // Intentionally no webCfg — SVG generation is pure; web tools would
          // add latency and non-determinism without improving the drawing.
          tools: toolsRegistry,
          db: ctx.db,
          queue: ctx.queue,
          renderer,
          systemPromptOverride: resolvePrompt("kb.illustration", {
            project: r.project,
          }),
        });

        const svg = extractSvgBlock(finalAnswer);
        if (!svg) {
          setSvgError(ctx.db, id, "model did not return a valid SVG block");
          void ctx.queue.log({
            topic: "kb",
            kind: "definition.illustration.parse_error",
            userId: user.id,
            data: { id, project: r.project, term: r.def.term },
          });
          renderer.onError(
            "Illustration generation failed: model did not return a valid SVG",
          );
        } else {
          setSvgResult(ctx.db, id, svg);
          const bytes = new TextEncoder().encode(svg).length;
          const ev: SseEvent = {
            type: "kb_definition_illustration_generated",
            definitionId: id,
            bytes,
          };
          sink.enqueue(SSE_ENCODER.encode(`data: ${JSON.stringify(ev)}\n\n`));
          void ctx.queue.log({
            topic: "kb",
            kind: "definition.illustration.done",
            userId: user.id,
            data: { id, project: r.project, term: r.def.term, bytes },
          });
        }
      } catch (e) {
        const msg = errorMessage(e);
        try {
          setSvgError(ctx.db, id, msg);
        } catch {
          // swallow — DB may already be closed during test teardown
        }
        renderer.onError(msg);
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
      "X-Definition-Id": String(id),
    },
  });
}

function handleClearIllustration(
  ctx: KbRouteCtx,
  user: User,
  rawProject: string,
  id: number,
): Response {
  const r = loadDefinitionFor(ctx, user, rawProject, id, true);
  if (!r.ok) return r.error;

  const updated = clearSvgFields(ctx.db, id);
  void ctx.queue.log({
    topic: "kb",
    kind: "definition.illustration.clear",
    userId: user.id,
    data: { id, project: r.project, term: r.def.term },
  });
  return json({ definition: updated });
}

/**
 * Extract an SVG document from the model's final answer. Accepts a
 * ```svg``` fence, a bare ``` fence, or a loose <svg>…</svg> match — in that
 * order. Rejects payloads that don't contain `<svg`. Payloads larger than
 * ILLUSTRATION_MAX_BYTES are rejected so a runaway model can't fill the DB.
 */
export function extractSvgBlock(raw: string): string | null {
  const candidates: string[] = [];
  const fencedSvg = raw.match(/```svg\s*\n([\s\S]*?)\n```/);
  if (fencedSvg?.[1]) candidates.push(fencedSvg[1]);
  const fencedBare = raw.match(/```\s*\n([\s\S]*?)\n```/);
  if (fencedBare?.[1]) candidates.push(fencedBare[1]);
  const openIdx = raw.indexOf("<svg");
  const closeIdx = raw.lastIndexOf("</svg>");
  if (openIdx >= 0 && closeIdx > openIdx) {
    candidates.push(raw.slice(openIdx, closeIdx + "</svg>".length));
  }

  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed.includes("<svg")) continue;
    const svgStart = trimmed.indexOf("<svg");
    const svgEnd = trimmed.lastIndexOf("</svg>");
    if (svgStart < 0 || svgEnd <= svgStart) continue;
    const svg = trimmed.slice(svgStart, svgEnd + "</svg>".length);
    const bytes = new TextEncoder().encode(svg).length;
    if (bytes === 0 || bytes > ILLUSTRATION_MAX_BYTES) continue;
    return svg;
  }

  return null;
}
