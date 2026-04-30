/**
 * HTTP routes for Code projects.
 *
 * Mounted from `routes.ts:handleApi` between the contact and kb routes.
 *
 *   GET    /api/projects/:project/code
 *   POST   /api/projects/:project/code            { name, description?, gitUrl?, gitRef? }
 *   GET    /api/code/:id
 *   PATCH  /api/code/:id                           { description?, gitRef? }
 *   DELETE /api/code/:id
 *   POST   /api/code/:id/clone
 *   GET    /api/code/:id/tree?path=…
 *   GET    /api/code/:id/file?path=…&encoding=utf8|base64|raw
 *   POST   /api/code/:id/ask                       { question }
 *   POST   /api/code/:id/edit                      { instruction }        (SSE)
 */

import type { Database } from "bun:sqlite";
import type { BunnyConfig } from "../config.ts";
import type { BunnyQueue } from "../queue/bunqueue.ts";
import type { User } from "../auth/users.ts";
import { randomUUID } from "node:crypto";

import { errorMessage } from "../util/error.ts";
import { json, readJson } from "./http.ts";
import { canEditProject, canSeeProject } from "./routes.ts";
import { getProject, validateProjectName } from "../memory/projects.ts";
import {
  canEditCodeProject,
  createCodeProject,
  deleteCodeProject,
  getCodeProject,
  listCodeProjects,
  updateCodeProject,
  validateCodeProjectName,
} from "../memory/code_projects.ts";
import {
  listWorkspace,
  readWorkspaceFile,
  resolveForDownload,
} from "../memory/workspace_fs.ts";
import {
  cloneCodeProject,
  validateGitUrl,
  workspaceRelForCode,
} from "../code/clone.ts";
import { runGraph, graphFanouts } from "../code/graph/run.ts";
import { subscribeFanout } from "../agent/run_fanout.ts";
import { existsSync, readFileSync } from "node:fs";
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
import { renderPrompt } from "../prompts/resolve.ts";

export interface CodeRouteCtx {
  db: Database;
  queue: BunnyQueue;
  cfg: BunnyConfig;
}

export async function handleCodeRoute(
  req: Request,
  url: URL,
  ctx: CodeRouteCtx,
  user: User,
): Promise<Response | null> {
  const { pathname } = url;

  const listMatch = pathname.match(/^\/api\/projects\/([^/]+)\/code$/);
  if (listMatch) {
    const project = decodeURIComponent(listMatch[1]!);
    if (req.method === "GET") return handleList(ctx, user, project);
    if (req.method === "POST") return handleCreate(req, ctx, user, project);
  }

  const idMatch = pathname.match(/^\/api\/code\/(\d+)$/);
  if (idMatch) {
    const id = Number(idMatch[1]);
    if (req.method === "GET") return handleGet(ctx, user, id);
    if (req.method === "PATCH") return handlePatch(req, ctx, user, id);
    if (req.method === "DELETE") return handleDelete(ctx, user, id);
  }

  const cloneMatch = pathname.match(/^\/api\/code\/(\d+)\/clone$/);
  if (cloneMatch) {
    const id = Number(cloneMatch[1]);
    if (req.method === "POST") return handleClone(ctx, user, id);
  }

  const treeMatch = pathname.match(/^\/api\/code\/(\d+)\/tree$/);
  if (treeMatch) {
    const id = Number(treeMatch[1]);
    if (req.method === "GET") return handleTree(ctx, user, url, id);
  }

  const fileMatch = pathname.match(/^\/api\/code\/(\d+)\/file$/);
  if (fileMatch) {
    const id = Number(fileMatch[1]);
    if (req.method === "GET") return handleFile(ctx, user, url, id);
  }

  const askMatch = pathname.match(/^\/api\/code\/(\d+)\/ask$/);
  if (askMatch) {
    const id = Number(askMatch[1]);
    if (req.method === "POST") return handleAsk(req, ctx, user, id);
  }

  const editMatch = pathname.match(/^\/api\/code\/(\d+)\/edit$/);
  if (editMatch) {
    const id = Number(editMatch[1]);
    if (req.method === "POST") return handleEdit(req, ctx, user, id);
  }

  const chatMatch = pathname.match(/^\/api\/code\/(\d+)\/chat$/);
  if (chatMatch) {
    const id = Number(chatMatch[1]);
    if (req.method === "POST") return handleChat(req, ctx, user, id);
  }

  const graphRunMatch = pathname.match(/^\/api\/code\/(\d+)\/graph\/run$/);
  if (graphRunMatch) {
    const id = Number(graphRunMatch[1]);
    if (req.method === "POST") return handleGraphRun(ctx, user, id);
  }

  const graphStreamMatch = pathname.match(/^\/api\/code\/(\d+)\/graph\/stream$/);
  if (graphStreamMatch) {
    const id = Number(graphStreamMatch[1]);
    if (req.method === "GET") return handleGraphStream(ctx, user, id);
  }

  const graphDataMatch = pathname.match(/^\/api\/code\/(\d+)\/graph\/data$/);
  if (graphDataMatch) {
    const id = Number(graphDataMatch[1]);
    if (req.method === "GET") return handleGraphData(ctx, user, id);
  }

  const graphReportMatch = pathname.match(/^\/api\/code\/(\d+)\/graph\/report$/);
  if (graphReportMatch) {
    const id = Number(graphReportMatch[1]);
    if (req.method === "GET") return handleGraphReport(ctx, user, id);
  }

  return null;
}

// ── Handlers ──────────────────────────────────────────────────────────────

function handleList(
  ctx: CodeRouteCtx,
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
  return json({ codeProjects: listCodeProjects(ctx.db, project) });
}

async function handleCreate(
  req: Request,
  ctx: CodeRouteCtx,
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
  if (!canEditProject(p, user)) return json({ error: "forbidden" }, 403);

  const body = await readJson<{
    name?: string;
    description?: string;
    gitUrl?: string | null;
    gitRef?: string | null;
  }>(req);
  if (!body) return json({ error: "invalid json" }, 400);

  let name: string;
  try {
    name = validateCodeProjectName(body.name);
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }

  let gitUrl: string | null = null;
  if (body.gitUrl !== undefined && body.gitUrl !== null && body.gitUrl !== "") {
    try {
      gitUrl = validateGitUrl(body.gitUrl);
    } catch (e) {
      return json({ error: errorMessage(e) }, 400);
    }
  }

  let created;
  try {
    created = createCodeProject(ctx.db, {
      project,
      name,
      description: body.description?.trim() ?? "",
      gitUrl,
      gitRef: body.gitRef?.trim() || null,
      createdBy: user.id,
    });
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }

  void ctx.queue.log({
    topic: "code",
    kind: "create",
    userId: user.id,
    data: { id: created.id, project, name, hasGitUrl: !!gitUrl },
  });

  if (gitUrl) {
    // Fire-and-forget clone — caller sees `git_status === 'cloning'` in the
    // response and polls for transitions.
    void cloneCodeProject(
      { db: ctx.db, queue: ctx.queue, cfg: ctx.cfg.code, userId: user.id },
      created.id,
    );
  } else {
    // No remote — materialise the empty dir + mark ready in the background so
    // the file tree can render immediately. Still fire-and-forget.
    void cloneCodeProject(
      { db: ctx.db, queue: ctx.queue, cfg: ctx.cfg.code, userId: user.id },
      created.id,
    );
  }

  return json({ codeProject: created }, 201);
}

function handleGet(ctx: CodeRouteCtx, user: User, id: number): Response {
  const cp = getCodeProject(ctx.db, id);
  if (!cp) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, cp.project);
  if (!p || !canSeeProject(p, user)) return json({ error: "forbidden" }, 403);
  return json({ codeProject: cp });
}

async function handlePatch(
  req: Request,
  ctx: CodeRouteCtx,
  user: User,
  id: number,
): Promise<Response> {
  const cp = getCodeProject(ctx.db, id);
  if (!cp) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, cp.project);
  if (!p) return json({ error: "project not found" }, 404);
  if (!canEditCodeProject(user, cp, p))
    return json({ error: "forbidden" }, 403);

  const body = await readJson<{ description?: string; gitRef?: string | null }>(
    req,
  );
  if (!body) return json({ error: "invalid json" }, 400);

  try {
    const updated = updateCodeProject(ctx.db, id, {
      description: body.description,
      gitRef:
        body.gitRef === undefined
          ? undefined
          : body.gitRef === null || body.gitRef === ""
            ? null
            : body.gitRef.trim(),
    });
    void ctx.queue.log({
      topic: "code",
      kind: "update",
      userId: user.id,
      data: { id, project: cp.project },
    });
    return json({ codeProject: updated });
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

function handleDelete(ctx: CodeRouteCtx, user: User, id: number): Response {
  const cp = getCodeProject(ctx.db, id);
  if (!cp) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, cp.project);
  if (!p) return json({ error: "project not found" }, 404);
  if (!canEditCodeProject(user, cp, p))
    return json({ error: "forbidden" }, 403);

  deleteCodeProject(ctx.db, id, user.id);
  void ctx.queue.log({
    topic: "code",
    kind: "delete",
    userId: user.id,
    data: { id, project: cp.project, name: cp.name, soft: true },
  });
  return json({ ok: true });
}

function handleClone(ctx: CodeRouteCtx, user: User, id: number): Response {
  const cp = getCodeProject(ctx.db, id);
  if (!cp) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, cp.project);
  if (!p) return json({ error: "project not found" }, 404);
  if (!canEditCodeProject(user, cp, p))
    return json({ error: "forbidden" }, 403);
  if (cp.gitStatus === "cloning") {
    return json({ error: "clone already in progress" }, 409);
  }

  void cloneCodeProject(
    { db: ctx.db, queue: ctx.queue, cfg: ctx.cfg.code, userId: user.id },
    id,
  );
  return json({ ok: true, codeProject: { ...cp, gitStatus: "cloning" } }, 202);
}

function handleTree(
  ctx: CodeRouteCtx,
  user: User,
  url: URL,
  id: number,
): Response {
  const cp = getCodeProject(ctx.db, id);
  if (!cp) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, cp.project);
  if (!p || !canSeeProject(p, user)) return json({ error: "forbidden" }, 403);
  const sub = url.searchParams.get("path")?.replace(/^\/+/, "") ?? "";
  const relPath = sub
    ? `${workspaceRelForCode(cp)}/${sub}`
    : workspaceRelForCode(cp);
  try {
    const entries = listWorkspace(cp.project, relPath).map((e) => ({
      ...e,
      // Strip the code/<name>/ prefix from the returned path so the UI sees
      // paths relative to the code project root, not the workspace root.
      path: stripCodePrefix(cp.name, e.path),
    }));
    return json({ codeProjectId: id, path: sub, entries });
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

function handleFile(
  ctx: CodeRouteCtx,
  user: User,
  url: URL,
  id: number,
): Response {
  const cp = getCodeProject(ctx.db, id);
  if (!cp) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, cp.project);
  if (!p || !canSeeProject(p, user)) return json({ error: "forbidden" }, 403);
  const sub = url.searchParams.get("path")?.replace(/^\/+/, "");
  if (!sub) return json({ error: "missing path" }, 400);
  const encoding = url.searchParams.get("encoding") ?? "utf8";
  const relPath = `${workspaceRelForCode(cp)}/${sub}`;
  try {
    if (encoding === "raw") {
      const { abs } = resolveForDownload(cp.project, relPath);
      return new Response(Bun.file(abs));
    }
    if (encoding !== "utf8" && encoding !== "base64") {
      return json({ error: `unsupported encoding '${encoding}'` }, 400);
    }
    const result = readWorkspaceFile(cp.project, relPath, encoding);
    return json({
      ...result,
      path: stripCodePrefix(cp.name, result.path),
    });
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

// ── Ask mode ──────────────────────────────────────────────────────────────

async function handleAsk(
  req: Request,
  ctx: CodeRouteCtx,
  user: User,
  id: number,
): Promise<Response> {
  const cp = getCodeProject(ctx.db, id);
  if (!cp) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, cp.project);
  if (!p) return json({ error: "project not found" }, 404);
  if (!canSeeProject(p, user)) return json({ error: "forbidden" }, 403);

  const body = await readJson<{ question?: string }>(req);
  const question = body?.question?.trim();
  if (!question) return json({ error: "missing question" }, 400);

  const sessionId = randomUUID();
  const listing = safeTopLevelListing(cp.project, cp.name);
  const graphSummary = safeGraphSummary(cp.project, cp.name);
  const prompt = renderPrompt(
    "code.ask",
    {
      codeProjectName: cp.name,
      codeProjectPath: workspaceRelForCode(cp),
      fileListing: listing,
      graphSummary,
      question,
    },
    { project: cp.project },
  );

  setSessionQuickChat(ctx.db, user.id, sessionId, true);

  void ctx.queue.log({
    topic: "code",
    kind: "ask",
    userId: user.id,
    data: { id, project: cp.project, sessionId },
  });

  return json({
    sessionId,
    project: cp.project,
    prompt,
    isQuickChat: true,
  });
}

// ── Edit mode (SSE) ───────────────────────────────────────────────────────

async function handleEdit(
  req: Request,
  ctx: CodeRouteCtx,
  user: User,
  id: number,
): Promise<Response> {
  const cp = getCodeProject(ctx.db, id);
  if (!cp) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, cp.project);
  if (!p) return json({ error: "project not found" }, 404);
  if (!canEditCodeProject(user, cp, p))
    return json({ error: "forbidden" }, 403);

  const body = await readJson<{ instruction?: string }>(req);
  const instruction = body?.instruction?.trim();
  if (!instruction) return json({ error: "missing instruction" }, 400);

  const sessionId = `code-edit-${randomUUID()}`;
  const listing = safeTopLevelListing(cp.project, cp.name);
  const systemPrompt = renderPrompt(
    "code.edit",
    {
      codeProjectName: cp.name,
      codeProjectPath: workspaceRelForCode(cp),
      fileListing: listing,
      instruction,
    },
    { project: cp.project },
  );

  setSessionHiddenFromChat(ctx.db, user.id, sessionId, true);

  void ctx.queue.log({
    topic: "code",
    kind: "edit",
    userId: user.id,
    data: { id, project: cp.project, sessionId },
  });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const sink = controllerSink(controller);
      const renderer = createSseRenderer(sink);

      try {
        await runAgent({
          prompt: instruction,
          sessionId,
          userId: user.id,
          project: cp.project,
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
      "X-Code-Project-Id": String(id),
    },
  });
}

// ── Chat mode (persistent, SSE) ───────────────────────────────────────────

async function handleChat(
  req: Request,
  ctx: CodeRouteCtx,
  user: User,
  id: number,
): Promise<Response> {
  const cp = getCodeProject(ctx.db, id);
  if (!cp) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, cp.project);
  if (!p) return json({ error: "project not found" }, 404);
  if (!canEditCodeProject(user, cp, p))
    return json({ error: "forbidden" }, 403);

  const body = await readJson<{ sessionId?: string; prompt?: string }>(req);
  const prompt = body?.prompt?.trim();
  if (!prompt) return json({ error: "missing prompt" }, 400);
  // Mint a prefixed id for fresh code-chat sessions so the frontend can list
  // them via the generic /api/sessions endpoint + a simple startsWith filter.
  // A caller-supplied id (existing conversation being continued) is used as-is.
  const sessionId =
    body?.sessionId?.trim() || `code-chat-${id}-${randomUUID()}`;

  const listing = safeTopLevelListing(cp.project, cp.name);
  const graphSummary = safeGraphSummary(cp.project, cp.name);
  const systemPrompt = renderPrompt(
    "code.chat",
    {
      codeProjectName: cp.name,
      codeProjectPath: workspaceRelForCode(cp),
      fileListing: listing,
      graphSummary,
    },
    { project: cp.project },
  );

  void ctx.queue.log({
    topic: "code",
    kind: "chat",
    userId: user.id,
    data: { id, project: cp.project, sessionId },
  });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const sink = controllerSink(controller);
      const renderer = createSseRenderer(sink);

      try {
        await runAgent({
          prompt,
          sessionId,
          userId: user.id,
          project: cp.project,
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
      "X-Code-Project-Id": String(id),
    },
  });
}

// ── Graph feature (ADR 0033) ──────────────────────────────────────────────

async function handleGraphRun(
  ctx: CodeRouteCtx,
  user: User,
  id: number,
): Promise<Response> {
  if (!ctx.cfg.code.graph.enabled) {
    return json({ error: "code graph disabled" }, 503);
  }
  const cp = getCodeProject(ctx.db, id);
  if (!cp) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, cp.project);
  if (!p) return json({ error: "project not found" }, 404);
  if (!canEditCodeProject(user, cp, p))
    return json({ error: "forbidden" }, 403);
  if (cp.gitStatus !== "ready") {
    return json({ error: "code project is not ready" }, 409);
  }

  const result = await runGraph(
    { db: ctx.db, queue: ctx.queue, cfg: ctx.cfg, userId: user.id },
    id,
  );
  if (!result.ok) {
    return json({ error: "graph run already in progress" }, 409);
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const sink = controllerSink(controller);
      const unsubscribe = subscribeFanout(graphFanouts, id, sink);
      void unsubscribe;
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

function handleGraphStream(
  ctx: CodeRouteCtx,
  user: User,
  id: number,
): Response {
  const cp = getCodeProject(ctx.db, id);
  if (!cp) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, cp.project);
  if (!p || !canSeeProject(p, user)) return json({ error: "forbidden" }, 403);

  const fan = graphFanouts.get(id);
  if (!fan) return json({ error: "no active graph run" }, 404);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const sink = controllerSink(controller);
      const unsubscribe = subscribeFanout(graphFanouts, id, sink);
      if (fan.closed) finishSse(sink);
      void unsubscribe;
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

function handleGraphData(
  ctx: CodeRouteCtx,
  user: User,
  id: number,
): Response {
  const cp = getCodeProject(ctx.db, id);
  if (!cp) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, cp.project);
  if (!p || !canSeeProject(p, user)) return json({ error: "forbidden" }, 403);

  let abs: string;
  try {
    abs = graphOutFile(cp.project, cp.name, "graph.json");
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
  if (!existsSync(abs)) {
    return json({ error: "graph not generated yet" }, 404);
  }
  try {
    const text = readFileSync(abs, "utf8");
    return new Response(text, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-cache",
      },
    });
  } catch (e) {
    return json({ error: errorMessage(e) }, 500);
  }
}

function handleGraphReport(
  ctx: CodeRouteCtx,
  user: User,
  id: number,
): Response {
  const cp = getCodeProject(ctx.db, id);
  if (!cp) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, cp.project);
  if (!p || !canSeeProject(p, user)) return json({ error: "forbidden" }, 403);

  let abs: string;
  try {
    abs = graphOutFile(cp.project, cp.name, "GRAPH_REPORT.md");
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
  if (!existsSync(abs)) {
    return json({ error: "report not generated yet" }, 404);
  }
  try {
    const text = readFileSync(abs, "utf8");
    return new Response(text, {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Cache-Control": "no-cache",
      },
    });
  } catch (e) {
    return json({ error: errorMessage(e) }, 500);
  }
}

function graphOutFile(project: string, name: string, filename: string): string {
  // `code/.graph-out/<name>/` sits beside the cloned repo (not inside it) so
  // the working tree stays clean across re-clones. `resolveForDownload`
  // enforces the protected-root check and rejects traversal.
  const rel = `code/.graph-out/${name}/${filename}`;
  const { abs } = resolveForDownload(project, rel);
  return abs;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function stripCodePrefix(name: string, workspacePath: string): string {
  const root = workspaceRelForCode({ name });
  if (workspacePath === root) return "";
  const prefix = `${root}/`;
  if (workspacePath.startsWith(prefix))
    return workspacePath.slice(prefix.length);
  return workspacePath;
}

/**
 * Returns the current `GRAPH_REPORT.md` for this code project so the chat /
 * ask prompts can ground their answers in it. Falls back to a neutral
 * placeholder when no graph has been generated yet — the prompt then nudges
 * the user toward running the Graph feature.
 */
function safeGraphSummary(project: string, name: string): string {
  try {
    const abs = graphOutFile(project, name, "GRAPH_REPORT.md");
    if (existsSync(abs)) {
      const text = readFileSync(abs, "utf8").trim();
      if (text.length > 0) return text;
    }
  } catch {
    /* fall through to placeholder */
  }
  return "_No knowledge graph has been generated for this project yet. If a structural overview would help, suggest the user run the Graph feature in the Code tab; otherwise rely on the file listing above and read files directly._";
}

/**
 * Compact top-level file listing for the LLM prompt. Best-effort — a missing
 * directory (status !== 'ready') yields a neutral placeholder.
 */
function safeTopLevelListing(project: string, name: string): string {
  const root = workspaceRelForCode({ name });
  try {
    const entries = listWorkspace(project, root);
    const lines: string[] = [];
    for (const e of entries.slice(0, 200)) {
      lines.push(
        `- ${stripCodePrefix(name, e.path) || e.name}${e.kind === "dir" ? "/" : ""}`,
      );
    }
    if (entries.length > 200) lines.push(`- … (${entries.length - 200} more)`);
    return lines.join("\n") || "(empty)";
  } catch {
    return "(repository not yet available)";
  }
}
