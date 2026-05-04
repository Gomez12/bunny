/**
 * HTTP routes for per-project workflows.
 *
 *   GET    /api/projects/:project/workflows
 *   POST   /api/projects/:project/workflows           { slug?, tomlText, layout? }
 *   GET    /api/workflows/:id                          { def, layout, tomlText, sha, bashApprovals }
 *   PUT    /api/workflows/:id                          { tomlText?, layout?, bashApprovals? }
 *   DELETE /api/workflows/:id                          → soft-delete (trash)
 *   POST   /api/workflows/:id/run                     → { runId, sessionId }
 *   POST   /api/workflows/runs/:runId/cancel
 *   GET    /api/workflows/:id/runs?limit=50
 *   GET    /api/workflows/runs/:runId                  { run, nodes[] }
 *   GET    /api/workflows/runs/:runId/stream           SSE
 *   GET    /api/workflows/runs/:runId/nodes/:nodeId/log
 *   POST   /api/sessions/:sid/questions/:qid/answer    (reuses existing chat route)
 */

import type { Database } from "bun:sqlite";
import type { User } from "../auth/users.ts";
import type { BunnyConfig } from "../config.ts";
import type { BunnyQueue } from "../queue/bunqueue.ts";
import { errorMessage } from "../util/error.ts";
import { json, readJson } from "./http.ts";
import { canEditProject, canSeeProject } from "./routes.ts";
import { getProject, validateProjectName } from "../memory/projects.ts";
import { registry as toolsRegistry } from "../tools/index.ts";
import { controllerSink, finishSse } from "../agent/render_sse.ts";
import { softDelete } from "../memory/trash.ts";
import {
  createWorkflow,
  getWorkflow,
  getWorkflowBySlug,
  listWorkflows,
  updateWorkflow,
  validateWorkflowSlug,
  type Workflow,
} from "../memory/workflows.ts";
import {
  hashWorkflowToml,
  loadWorkflowToml,
  writeWorkflowToml,
} from "../memory/workflow_assets.ts";
import {
  getRun,
  listRunNodes,
  listRunsForWorkflow,
  findRunNodeByNodeId,
  markRunCancelled,
  type WorkflowRun,
  type WorkflowRunNode,
} from "../memory/workflow_runs.ts";
import { parseWorkflowToml } from "../workflows/schema.ts";
import {
  getWorkflowRunFanout,
  requestCancelWorkflowRun,
  runWorkflow,
  subscribeToWorkflowRun,
} from "../workflows/run_workflow.ts";

export interface WorkflowRouteCtx {
  db: Database;
  queue: BunnyQueue;
  cfg: BunnyConfig;
}

export async function handleWorkflowRoute(
  req: Request,
  url: URL,
  ctx: WorkflowRouteCtx,
  user: User,
): Promise<Response | null> {
  const { pathname } = url;

  const listMatch = pathname.match(/^\/api\/projects\/([^/]+)\/workflows$/);
  if (listMatch) {
    const project = decodeURIComponent(listMatch[1]!);
    if (req.method === "GET") return handleList(ctx, user, project);
    if (req.method === "POST") return handleCreate(req, ctx, user, project);
  }

  const idMatch = pathname.match(/^\/api\/workflows\/(\d+)$/);
  if (idMatch) {
    const id = Number(idMatch[1]);
    if (req.method === "GET") return handleGet(ctx, user, id);
    if (req.method === "PUT") return handleUpdate(req, ctx, user, id);
    if (req.method === "DELETE") return handleDelete(ctx, user, id);
  }

  const runMatch = pathname.match(/^\/api\/workflows\/(\d+)\/run$/);
  if (runMatch) {
    const id = Number(runMatch[1]);
    if (req.method === "POST") return handleRun(ctx, user, id);
  }

  const runsMatch = pathname.match(/^\/api\/workflows\/(\d+)\/runs$/);
  if (runsMatch) {
    const id = Number(runsMatch[1]);
    if (req.method === "GET") return handleListRuns(ctx, user, url, id);
  }

  const runGetMatch = pathname.match(/^\/api\/workflows\/runs\/(\d+)$/);
  if (runGetMatch) {
    const runId = Number(runGetMatch[1]);
    if (req.method === "GET") return handleGetRun(ctx, user, runId);
  }

  const cancelMatch = pathname.match(/^\/api\/workflows\/runs\/(\d+)\/cancel$/);
  if (cancelMatch) {
    const runId = Number(cancelMatch[1]);
    if (req.method === "POST") return handleCancelRun(ctx, user, runId);
  }

  const streamMatch = pathname.match(/^\/api\/workflows\/runs\/(\d+)\/stream$/);
  if (streamMatch) {
    const runId = Number(streamMatch[1]);
    if (req.method === "GET") return handleStreamRun(ctx, user, runId);
  }

  const logMatch = pathname.match(
    /^\/api\/workflows\/runs\/(\d+)\/nodes\/([^/]+)\/log$/,
  );
  if (logMatch) {
    const runId = Number(logMatch[1]);
    const nodeId = decodeURIComponent(logMatch[2]!);
    if (req.method === "GET") return handleNodeLog(ctx, user, runId, nodeId);
  }

  return null;
}

// ── DTOs ─────────────────────────────────────────────────────────────────────

interface WorkflowDto {
  id: number;
  project: string;
  slug: string;
  name: string;
  description: string | null;
  tomlSha256: string;
  layoutJson: string | null;
  bashApprovals: Record<string, string>;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

function toWorkflowDto(w: Workflow): WorkflowDto {
  return {
    id: w.id,
    project: w.project,
    slug: w.slug,
    name: w.name,
    description: w.description,
    tomlSha256: w.tomlSha256,
    layoutJson: w.layoutJson,
    bashApprovals: w.bashApprovals,
    createdBy: w.createdBy,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  };
}

interface RunDto {
  id: number;
  workflowId: number;
  project: string;
  sessionId: string;
  status: WorkflowRun["status"];
  triggerKind: WorkflowRun["triggerKind"];
  triggeredBy: string | null;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
}
function toRunDto(r: WorkflowRun): RunDto {
  return {
    id: r.id,
    workflowId: r.workflowId,
    project: r.project,
    sessionId: r.sessionId,
    status: r.status,
    triggerKind: r.triggerKind,
    triggeredBy: r.triggeredBy,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    error: r.error,
  };
}

function toRunNodeDto(n: WorkflowRunNode): WorkflowRunNode {
  return n;
}

// ── Handlers ─────────────────────────────────────────────────────────────────

function handleList(
  ctx: WorkflowRouteCtx,
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
  return json({
    workflows: listWorkflows(ctx.db, project).map(toWorkflowDto),
  });
}

interface CreateBody {
  slug?: string;
  tomlText?: string;
  layout?: unknown;
}

async function handleCreate(
  req: Request,
  ctx: WorkflowRouteCtx,
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

  const body = (await readJson<CreateBody>(req)) ?? {};
  const tomlText = typeof body.tomlText === "string" ? body.tomlText : "";
  if (!tomlText.trim()) return json({ error: "missing 'tomlText'" }, 400);

  const parsed = parseWorkflowToml(tomlText);
  if (!parsed.def) {
    return json(
      { error: "invalid workflow TOML", details: parsed.errors },
      400,
    );
  }

  // Slug: explicit body.slug wins; otherwise derived from def.name.
  let slug: string;
  try {
    const candidate =
      body.slug && body.slug.trim() ? body.slug : parsed.def.name;
    slug = validateWorkflowSlug(candidate);
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }

  if (getWorkflowBySlug(ctx.db, project, slug)) {
    return json({ error: `workflow slug '${slug}' already exists` }, 409);
  }

  const layoutJson =
    body.layout === undefined || body.layout === null
      ? null
      : JSON.stringify(body.layout);

  try {
    writeWorkflowToml(project, slug, tomlText);
  } catch (e) {
    return json({ error: errorMessage(e) }, 500);
  }

  const wf = createWorkflow(ctx.db, {
    project,
    slug,
    name: parsed.def.name,
    description: parsed.def.description ?? null,
    tomlSha256: hashWorkflowToml(tomlText),
    layoutJson,
    createdBy: user.id,
  });

  void ctx.queue.log({
    topic: "workflows",
    kind: "create",
    userId: user.id,
    data: { project, id: wf.id, slug, nodeCount: parsed.def.nodes.length },
  });

  return json({ workflow: toWorkflowDto(wf), tomlText }, 201);
}

function handleGet(ctx: WorkflowRouteCtx, user: User, id: number): Response {
  const wf = getWorkflow(ctx.db, id);
  if (!wf) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, wf.project);
  if (!p || !canSeeProject(p, user)) return json({ error: "forbidden" }, 403);
  const tomlText = loadWorkflowToml(wf.project, wf.slug);
  return json({ workflow: toWorkflowDto(wf), tomlText });
}

interface UpdateBody {
  tomlText?: string;
  layout?: unknown;
}

async function handleUpdate(
  req: Request,
  ctx: WorkflowRouteCtx,
  user: User,
  id: number,
): Promise<Response> {
  const wf = getWorkflow(ctx.db, id);
  if (!wf) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, wf.project);
  if (!p || !canEditProject(p, user)) return json({ error: "forbidden" }, 403);

  const body = (await readJson<UpdateBody>(req)) ?? {};
  const patch: Parameters<typeof updateWorkflow>[2] = {};

  if (typeof body.tomlText === "string") {
    const parsed = parseWorkflowToml(body.tomlText);
    if (!parsed.def) {
      return json(
        { error: "invalid workflow TOML", details: parsed.errors },
        400,
      );
    }
    writeWorkflowToml(wf.project, wf.slug, body.tomlText);
    patch.name = parsed.def.name;
    patch.description = parsed.def.description ?? null;
    patch.tomlSha256 = hashWorkflowToml(body.tomlText);
  }
  if (body.layout !== undefined) {
    patch.layoutJson =
      body.layout === null ? null : JSON.stringify(body.layout);
  }

  if (Object.keys(patch).length === 0) {
    return json({ workflow: toWorkflowDto(wf) });
  }

  const next = updateWorkflow(ctx.db, id, patch);
  void ctx.queue.log({
    topic: "workflows",
    kind: "update",
    userId: user.id,
    data: {
      id,
      project: wf.project,
      slug: wf.slug,
      changed: Object.keys(patch),
    },
  });
  const tomlText = loadWorkflowToml(next.project, next.slug);
  return json({ workflow: toWorkflowDto(next), tomlText });
}

function handleDelete(ctx: WorkflowRouteCtx, user: User, id: number): Response {
  const wf = getWorkflow(ctx.db, id);
  if (!wf) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, wf.project);
  if (!p || !canEditProject(p, user)) return json({ error: "forbidden" }, 403);
  const ok = softDelete(ctx.db, "workflow", id, user.id);
  if (!ok) return json({ error: "already deleted" }, 409);
  void ctx.queue.log({
    topic: "workflows",
    kind: "delete",
    userId: user.id,
    data: { id, project: wf.project, slug: wf.slug },
  });
  return json({ ok: true });
}

function handleRun(ctx: WorkflowRouteCtx, user: User, id: number): Response {
  const wf = getWorkflow(ctx.db, id);
  if (!wf) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, wf.project);
  if (!p || !canEditProject(p, user)) return json({ error: "forbidden" }, 403);

  // Early 403 when bash nodes are present but the flag is off. Re-checked at
  // dispatch time — this is just UX so the user sees the error before SSE.
  const tomlText = loadWorkflowToml(wf.project, wf.slug);
  if (!tomlText) return json({ error: "workflow TOML missing" }, 500);
  const parsed = parseWorkflowToml(tomlText);
  if (!parsed.def) {
    return json(
      { error: "invalid workflow TOML", details: parsed.errors },
      400,
    );
  }
  const hasBash = parsed.def.nodes.some((n) => n.kind === "bash");
  if (hasBash && !ctx.cfg.workflows.bashEnabled) {
    return json(
      {
        error:
          "this workflow contains bash nodes — set [workflows] bash_enabled = true in bunny.config.toml first",
      },
      403,
    );
  }
  const hasScript = parsed.def.nodes.some((n) => n.kind === "script");
  if (hasScript && !ctx.cfg.workflows.scriptEnabled) {
    return json(
      {
        error:
          "this workflow contains script nodes — set [workflows] script_enabled = true in bunny.config.toml first",
      },
      403,
    );
  }

  try {
    const { run, sessionId } = runWorkflow({
      db: ctx.db,
      queue: ctx.queue,
      cfg: ctx.cfg,
      tools: toolsRegistry,
      workflowId: id,
      triggeredBy: user.id,
      triggerKind: "manual",
    });
    return json({ run: toRunDto(run), sessionId }, 202);
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

function handleListRuns(
  ctx: WorkflowRouteCtx,
  user: User,
  url: URL,
  id: number,
): Response {
  const wf = getWorkflow(ctx.db, id);
  if (!wf) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, wf.project);
  if (!p || !canSeeProject(p, user)) return json({ error: "forbidden" }, 403);
  const limit = Number(url.searchParams.get("limit") ?? "50");
  const runs = listRunsForWorkflow(ctx.db, id, limit).map(toRunDto);
  return json({ runs });
}

function handleGetRun(
  ctx: WorkflowRouteCtx,
  user: User,
  runId: number,
): Response {
  const run = getRun(ctx.db, runId);
  if (!run) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, run.project);
  if (!p || !canSeeProject(p, user)) return json({ error: "forbidden" }, 403);
  return json({
    run: toRunDto(run),
    nodes: listRunNodes(ctx.db, runId).map(toRunNodeDto),
  });
}

function handleCancelRun(
  ctx: WorkflowRouteCtx,
  user: User,
  runId: number,
): Response {
  const run = getRun(ctx.db, runId);
  if (!run) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, run.project);
  if (!p || !canEditProject(p, user)) return json({ error: "forbidden" }, 403);
  const live = requestCancelWorkflowRun(runId);
  if (!live && (run.status === "running" || run.status === "paused")) {
    // The fanout has been dropped but the DB row still says running — this
    // can happen after a restart. Persist a cancel so the UI shows the
    // correct state.
    markRunCancelled(ctx.db, runId);
  }
  void ctx.queue.log({
    topic: "workflows",
    kind: "run.cancel",
    userId: user.id,
    data: { runId },
  });
  return json({ ok: true, live });
}

function handleStreamRun(
  ctx: WorkflowRouteCtx,
  user: User,
  runId: number,
): Response {
  const run = getRun(ctx.db, runId);
  if (!run) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, run.project);
  if (!p || !canSeeProject(p, user)) return json({ error: "forbidden" }, 403);

  const fan = getWorkflowRunFanout(runId);
  if (!fan) return json({ error: "run already completed" }, 409);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const sink = controllerSink(controller);
      subscribeToWorkflowRun(runId, sink);
      if (fan.closed) finishSse(sink);
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

function handleNodeLog(
  ctx: WorkflowRouteCtx,
  user: User,
  runId: number,
  nodeId: string,
): Response {
  const run = getRun(ctx.db, runId);
  if (!run) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, run.project);
  if (!p || !canSeeProject(p, user)) return json({ error: "forbidden" }, 403);
  const node = findRunNodeByNodeId(ctx.db, runId, nodeId);
  if (!node) return json({ error: "node not found in this run" }, 404);
  return json({ node });
}
