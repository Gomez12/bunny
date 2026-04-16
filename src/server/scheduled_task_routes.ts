/**
 * HTTP routes for the generic scheduler.
 *
 * Endpoints:
 *   GET    /api/tasks                 — list tasks the caller is allowed to see
 *   POST   /api/tasks                 — create a task (system: admin only)
 *   GET    /api/tasks/:id             — fetch one (respecting kind/ownership)
 *   PATCH  /api/tasks/:id             — update (admin for system; owner or admin for user)
 *   DELETE /api/tasks/:id             — delete (same rules as patch)
 *   POST   /api/tasks/:id/run-now     — fire the handler immediately
 *   GET    /api/tasks/handlers        — list registered handler names
 *
 * All users see system-tasks. Admins see every user-task; ordinary users see
 * only their own.
 */

import type { Database } from "bun:sqlite";
import type { BunnyQueue } from "../queue/bunqueue.ts";
import type { User } from "../auth/users.ts";
import type { SchedulerHandle } from "../scheduler/ticker.ts";
import type { HandlerRegistry } from "../scheduler/handlers.ts";
import { json } from "./http.ts";
import { errorMessage } from "../util/error.ts";
import {
  createTask,
  deleteTask,
  getTask,
  listTasks,
  updateTask,
  type ScheduledTask,
  type TaskKind,
} from "../memory/scheduled_tasks.ts";
import { computeNextRun, parseCron } from "../scheduler/cron.ts";

export interface ScheduledTaskRouteCtx {
  db: Database;
  queue: BunnyQueue;
  scheduler: SchedulerHandle;
  registry: HandlerRegistry;
}

export async function handleScheduledTaskRoute(
  req: Request,
  url: URL,
  ctx: ScheduledTaskRouteCtx,
  user: User,
): Promise<Response | null> {
  const { pathname } = url;

  if (pathname === "/api/tasks/handlers" && req.method === "GET") {
    return json({ handlers: ctx.registry.list() });
  }

  if (pathname === "/api/tasks") {
    if (req.method === "GET") return handleList(ctx, user);
    if (req.method === "POST") return handleCreate(req, ctx, user);
  }

  const runNow = pathname.match(/^\/api\/tasks\/([^/]+)\/run-now$/);
  if (runNow && req.method === "POST") {
    return handleRunNow(ctx, user, decodeURIComponent(runNow[1]!));
  }

  const byId = pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (byId) {
    const id = decodeURIComponent(byId[1]!);
    if (req.method === "GET") return handleGet(ctx, user, id);
    if (req.method === "PATCH") return handlePatch(req, ctx, user, id);
    if (req.method === "DELETE") return handleDelete(ctx, user, id);
  }

  return null;
}

function canSee(user: User, task: ScheduledTask): boolean {
  if (task.kind === "system") return true;
  if (user.role === "admin") return true;
  return task.ownerUserId === user.id;
}

function canEdit(user: User, task: ScheduledTask): boolean {
  if (task.kind === "system") return user.role === "admin";
  if (user.role === "admin") return true;
  return task.ownerUserId === user.id;
}

function handleList(ctx: ScheduledTaskRouteCtx, user: User): Response {
  const system = listTasks(ctx.db, { kind: "system" });
  const users =
    user.role === "admin"
      ? listTasks(ctx.db, { kind: "user" })
      : listTasks(ctx.db, { kind: "user", ownerUserId: user.id });
  return json({ tasks: [...system, ...users] });
}

function handleGet(ctx: ScheduledTaskRouteCtx, user: User, id: string): Response {
  const task = getTask(ctx.db, id);
  if (!task) return json({ error: "not found" }, 404);
  if (!canSee(user, task)) return json({ error: "forbidden" }, 403);
  return json({ task: task });
}

interface CreateBody {
  kind?: TaskKind;
  handler?: string;
  name?: string;
  description?: string | null;
  cronExpr?: string;
  payload?: unknown;
  enabled?: boolean;
  ownerUserId?: string | null;
}

async function handleCreate(
  req: Request,
  ctx: ScheduledTaskRouteCtx,
  user: User,
): Promise<Response> {
  const body = (await readJson<CreateBody>(req)) ?? {};
  const kind: TaskKind = body.kind === "system" ? "system" : "user";
  if (kind === "system" && user.role !== "admin") {
    return json({ error: "only admins can create system tasks" }, 403);
  }

  const handler = (body.handler ?? "").trim();
  const name = (body.name ?? "").trim();
  const cronExpr = (body.cronExpr ?? "").trim();
  if (!handler || !name || !cronExpr) {
    return json({ error: "handler, name and cronExpr are required" }, 400);
  }
  if (!ctx.registry.get(handler)) {
    return json({ error: `no handler '${handler}' is registered` }, 400);
  }
  try {
    parseCron(cronExpr);
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }

  // Owner: system tasks have none; user-tasks default to the caller.
  let ownerUserId: string | null = null;
  if (kind === "user") {
    if (user.role === "admin" && body.ownerUserId !== undefined) {
      ownerUserId = body.ownerUserId;
    } else {
      ownerUserId = user.id;
    }
  }

  try {
    const now = Date.now();
    const task = createTask(ctx.db, {
      kind,
      handler,
      name,
      description: body.description ?? null,
      cronExpr,
      payload: body.payload,
      enabled: body.enabled !== false,
      ownerUserId,
      nextRunAt: computeNextRun(cronExpr, now),
    });
    void ctx.queue.log({ topic: "task", kind: "create", userId: user.id, data: { id: task.id, name, handler, taskKind: kind, cronExpr, enabled: body.enabled !== false } });
    return json({ task: task }, 201);
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

interface PatchBody {
  name?: string;
  description?: string | null;
  cronExpr?: string;
  payload?: unknown;
  enabled?: boolean;
}

async function handlePatch(
  req: Request,
  ctx: ScheduledTaskRouteCtx,
  user: User,
  id: string,
): Promise<Response> {
  const task = getTask(ctx.db, id);
  if (!task) return json({ error: "not found" }, 404);
  if (!canEdit(user, task)) return json({ error: "forbidden" }, 403);

  const body = (await readJson<PatchBody>(req)) ?? {};
  if (body.cronExpr !== undefined) {
    try {
      parseCron(body.cronExpr);
    } catch (e) {
      return json({ error: errorMessage(e) }, 400);
    }
  }
  try {
    const nextRunAt =
      body.cronExpr !== undefined ? computeNextRun(body.cronExpr, Date.now()) : undefined;
    const updated = updateTask(ctx.db, id, {
      name: body.name,
      description: body.description,
      cronExpr: body.cronExpr,
      payload: body.payload,
      enabled: body.enabled,
      nextRunAt,
    });
    const changed = Object.keys(body).filter((k) => (body as Record<string, unknown>)[k] !== undefined);
    void ctx.queue.log({ topic: "task", kind: "update", userId: user.id, data: { id, changed } });
    return json({ task: updated });
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

function handleDelete(ctx: ScheduledTaskRouteCtx, user: User, id: string): Response {
  const task = getTask(ctx.db, id);
  if (!task) return json({ error: "not found" }, 404);
  if (!canEdit(user, task)) return json({ error: "forbidden" }, 403);
  try {
    deleteTask(ctx.db, id);
    void ctx.queue.log({ topic: "task", kind: "delete", userId: user.id, data: { id } });
    return json({ ok: true });
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

async function handleRunNow(
  ctx: ScheduledTaskRouteCtx,
  user: User,
  id: string,
): Promise<Response> {
  const task = getTask(ctx.db, id);
  if (!task) return json({ error: "not found" }, 404);
  if (!canEdit(user, task)) return json({ error: "forbidden" }, 403);
  try {
    await ctx.scheduler.runTask(id);
    void ctx.queue.log({ topic: "task", kind: "run-now", userId: user.id, data: { id } });
    const refreshed = getTask(ctx.db, id);
    return json({ task: refreshed });
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

async function readJson<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}
