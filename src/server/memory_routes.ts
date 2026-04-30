/**
 * HTTP routes for per-(user, project) and per-(agent, project) memory.
 *
 * Soul lives on `users` and is exposed via `/api/users/me/soul` in
 * `auth_routes.ts`. This module handles the project-scoped memory variants:
 *
 *   GET/PUT /api/projects/:project/memory/me
 *   GET/PUT /api/projects/:project/memory/agents/:agent
 *   (admin) GET /api/projects/:project/memory/users/:userId
 *
 * Permissions: read = `canSeeProject`. Write own user-memory = any viewer.
 * Write agent-memory = admin or project creator (mirrors KB write rules).
 */

import type { Database } from "bun:sqlite";
import type { BunnyConfig } from "../config.ts";
import type { BunnyQueue } from "../queue/bunqueue.ts";
import type { User } from "../auth/users.ts";

import { getProject, validateProjectName } from "../memory/projects.ts";
import { getAgent, isAgentLinkedToProject } from "../memory/agents.ts";
import { canSeeProject } from "./routes.ts";
import { getUserById } from "../auth/users.ts";
import { json, readJson } from "./http.ts";
import { MEMORY_FIELD_CHAR_LIMIT } from "../memory/memory_constants.ts";
import {
  getUserProjectMemory,
  ensureUserProjectMemory,
  setUserProjectMemoryManual,
} from "../memory/user_project_memory.ts";
import {
  getAgentProjectMemory,
  ensureAgentProjectMemory,
  setAgentProjectMemoryManual,
} from "../memory/agent_project_memory.ts";

export interface MemoryRouteCtx {
  db: Database;
  queue: BunnyQueue;
  cfg: BunnyConfig;
}

const ME_RE = /^\/api\/projects\/([^/]+)\/memory\/me$/;
const AGENT_RE = /^\/api\/projects\/([^/]+)\/memory\/agents\/([^/]+)$/;
const USER_RE = /^\/api\/projects\/([^/]+)\/memory\/users\/([^/]+)$/;

export async function handleMemoryRoute(
  req: Request,
  url: URL,
  ctx: MemoryRouteCtx,
  user: User,
): Promise<Response | null> {
  const { pathname } = url;

  // /api/projects/:project/memory/me
  const meMatch = pathname.match(ME_RE);
  if (meMatch) {
    const project = decodeProject(meMatch[1]!);
    const guard = guardProject(ctx.db, user, project);
    if (guard) return guard;
    if (req.method === "GET") {
      const row =
        getUserProjectMemory(ctx.db, user.id, project) ??
        ensureUserProjectMemory(ctx.db, user.id, project);
      return json(toUserDto(row));
    }
    if (req.method === "PUT") return putUserMemory(req, ctx, user, project);
  }

  // /api/projects/:project/memory/agents/:agent
  const agentMatch = pathname.match(AGENT_RE);
  if (agentMatch) {
    const project = decodeProject(agentMatch[1]!);
    const agent = decodeURIComponent(agentMatch[2]!);
    const guard = guardProject(ctx.db, user, project);
    if (guard) return guard;
    if (!getAgent(ctx.db, agent)) {
      return json({ error: `agent '${agent}' does not exist` }, 404);
    }
    if (!isAgentLinkedToProject(ctx.db, project, agent)) {
      return json(
        { error: `agent '${agent}' is not linked to project '${project}'` },
        404,
      );
    }
    if (req.method === "GET") {
      const row =
        getAgentProjectMemory(ctx.db, agent, project) ??
        ensureAgentProjectMemory(ctx.db, agent, project);
      return json(toAgentDto(row));
    }
    if (req.method === "PUT")
      return putAgentMemory(req, ctx, user, project, agent);
  }

  // /api/projects/:project/memory/users/:userId — admin only.
  const userMatch = pathname.match(USER_RE);
  if (userMatch) {
    if (user.role !== "admin") return json({ error: "forbidden" }, 403);
    const project = decodeProject(userMatch[1]!);
    const targetId = decodeURIComponent(userMatch[2]!);
    const guard = guardProject(ctx.db, user, project);
    if (guard) return guard;
    if (!getUserById(ctx.db, targetId)) {
      return json({ error: "not found" }, 404);
    }
    if (req.method === "GET") {
      const row =
        getUserProjectMemory(ctx.db, targetId, project) ??
        ensureUserProjectMemory(ctx.db, targetId, project);
      return json(toUserDto(row));
    }
  }

  return null;
}

function decodeProject(raw: string): string {
  return validateProjectName(decodeURIComponent(raw));
}

/**
 * Resolve the project + run the visibility check. Returns a 404/403 response
 * when the project is missing or hidden, otherwise null so the caller proceeds.
 */
function guardProject(
  db: Database,
  user: User,
  project: string,
): Response | null {
  const p = getProject(db, project);
  if (!p) return json({ error: `project '${project}' does not exist` }, 404);
  if (!canSeeProject(p, user)) return json({ error: "forbidden" }, 403);
  return null;
}

function toUserDto(row: ReturnType<typeof ensureUserProjectMemory>) {
  return {
    userId: row.userId,
    project: row.project,
    memory: row.memory,
    status: row.status,
    error: row.error,
    refreshedAt: row.refreshedAt,
    manualEditedAt: row.manualEditedAt,
    watermarkMessageId: row.watermarkMessageId,
    maxChars: MEMORY_FIELD_CHAR_LIMIT,
  };
}

function toAgentDto(row: ReturnType<typeof ensureAgentProjectMemory>) {
  return {
    agent: row.agent,
    project: row.project,
    memory: row.memory,
    status: row.status,
    error: row.error,
    refreshedAt: row.refreshedAt,
    manualEditedAt: row.manualEditedAt,
    watermarkMessageId: row.watermarkMessageId,
    maxChars: MEMORY_FIELD_CHAR_LIMIT,
  };
}

async function putUserMemory(
  req: Request,
  ctx: MemoryRouteCtx,
  user: User,
  project: string,
): Promise<Response> {
  const body = await readJson<{ memory?: string }>(req);
  if (!body || typeof body.memory !== "string") {
    return json({ error: "memory (string) is required" }, 400);
  }
  if (body.memory.length > MEMORY_FIELD_CHAR_LIMIT) {
    return json(
      { error: `memory exceeds ${MEMORY_FIELD_CHAR_LIMIT}-char cap` },
      400,
    );
  }
  let updated;
  try {
    updated = setUserProjectMemoryManual(ctx.db, user.id, project, body.memory);
  } catch (e) {
    return json(
      { error: e instanceof Error ? e.message : "invalid memory" },
      400,
    );
  }
  void ctx.queue.log({
    topic: "memory",
    kind: "user_project.update",
    userId: user.id,
    data: { project, length: body.memory.length },
  });
  return json(toUserDto(updated));
}

async function putAgentMemory(
  req: Request,
  ctx: MemoryRouteCtx,
  user: User,
  project: string,
  agent: string,
): Promise<Response> {
  // Write permission for agent memory: admin OR project creator. Mirrors how
  // KB definitions hand out write rights — narrow enough that a casual viewer
  // can't reshape the agent's working knowledge.
  const p = getProject(ctx.db, project);
  if (!p) return json({ error: "not found" }, 404);
  const isOwner = !!p.createdBy && p.createdBy === user.id;
  if (user.role !== "admin" && !isOwner) {
    return json({ error: "forbidden" }, 403);
  }
  const body = await readJson<{ memory?: string }>(req);
  if (!body || typeof body.memory !== "string") {
    return json({ error: "memory (string) is required" }, 400);
  }
  if (body.memory.length > MEMORY_FIELD_CHAR_LIMIT) {
    return json(
      { error: `memory exceeds ${MEMORY_FIELD_CHAR_LIMIT}-char cap` },
      400,
    );
  }
  let updated;
  try {
    updated = setAgentProjectMemoryManual(ctx.db, agent, project, body.memory);
  } catch (e) {
    return json(
      { error: e instanceof Error ? e.message : "invalid memory" },
      400,
    );
  }
  void ctx.queue.log({
    topic: "memory",
    kind: "agent_project.update",
    userId: user.id,
    data: { project, agent, length: body.memory.length },
  });
  return json(toAgentDto(updated));
}
