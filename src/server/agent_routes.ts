/**
 * HTTP routes for agents (`/api/agents*`, `/api/projects/:p/agents*`,
 * `/api/tools`). Called from {@link ./routes.ts} before the generic
 * project/chat handlers so agent URLs always take precedence.
 */

import type { Database } from "bun:sqlite";
import type { User } from "../auth/users.ts";
import { errorMessage } from "../util/error.ts";
import { json } from "./http.ts";
import {
  createAgent,
  deleteAgent,
  getAgent,
  linkAgentToProject,
  listAgents,
  listAgentsForProject,
  listProjectsForAgent,
  mapProjectsByAgent,
  unlinkAgentFromProject,
  updateAgent,
  validateAgentName,
  type Agent,
  type AgentContextScope,
  type AgentVisibility,
} from "../memory/agents.ts";
import {
  ensureAgentDir,
  loadAgentAssets,
  writeAgentAssets,
  type AgentAssets,
} from "../memory/agent_assets.ts";
import { parseMemoryOverride } from "../memory/project_assets.ts";
import { getProject, validateProjectName } from "../memory/projects.ts";
import { registry } from "../tools/index.ts";
import { CALL_AGENT_TOOL_NAME } from "../tools/call_agent.ts";
import { BOARD_TOOL_NAMES } from "../tools/board.ts";

export interface AgentRouteCtx {
  db: Database;
  /** Project every new agent is auto-linked to so it shows up in the default chat. */
  defaultProject: string;
}

export async function handleAgentRoute(
  req: Request,
  url: URL,
  ctx: AgentRouteCtx,
  user: User,
): Promise<Response | null> {
  const { pathname } = url;

  if (pathname === "/api/tools" && req.method === "GET") {
    // Advertise tool names available to agents. `call_agent` is hidden — it
    // is injected implicitly when an agent has allowed subagents. Board
    // tools live on per-run closures (project-bound), but they ARE selectable
    // because including them in the whitelist toggles whether an agent has
    // board access at all.
    const names = [
      ...registry.names().filter((n) => n !== CALL_AGENT_TOOL_NAME),
      ...BOARD_TOOL_NAMES,
    ];
    return json({ tools: names });
  }

  if (pathname === "/api/agents" && req.method === "GET") {
    const agents = listAgents(ctx.db).filter((a) => canSeeAgent(a, user));
    const projectMap = mapProjectsByAgent(ctx.db);
    return json({ agents: agents.map((a) => toAgentDto(a, projectMap.get(a.name) ?? [])) });
  }

  if (pathname === "/api/agents" && req.method === "POST") {
    return handleCreateAgent(req, ctx, user);
  }

  const agentMatch = pathname.match(/^\/api\/agents\/([^/]+)$/);
  if (agentMatch) {
    const name = decodeURIComponent(agentMatch[1]!);
    if (req.method === "GET") return handleGetAgent(ctx, user, name);
    if (req.method === "PATCH") return handlePatchAgent(req, ctx, user, name);
    if (req.method === "DELETE") return handleDeleteAgent(ctx, user, name);
  }

  // /api/projects/:project/agents (list + link)
  const projectAgentsMatch = pathname.match(/^\/api\/projects\/([^/]+)\/agents$/);
  if (projectAgentsMatch) {
    const rawProject = decodeURIComponent(projectAgentsMatch[1]!);
    if (req.method === "GET") return handleListProjectAgents(ctx, user, rawProject);
    if (req.method === "POST") return handleLinkAgent(req, ctx, user, rawProject);
  }

  // /api/projects/:project/agents/:agent (unlink)
  const linkMatch = pathname.match(/^\/api\/projects\/([^/]+)\/agents\/([^/]+)$/);
  if (linkMatch) {
    const rawProject = decodeURIComponent(linkMatch[1]!);
    const rawAgent = decodeURIComponent(linkMatch[2]!);
    if (req.method === "DELETE") return handleUnlinkAgent(ctx, user, rawProject, rawAgent);
  }

  return null;
}

// ── DTO ────────────────────────────────────────────────────────────────────

export interface AgentDto {
  name: string;
  description: string;
  visibility: AgentVisibility;
  isSubagent: boolean;
  knowsOtherAgents: boolean;
  contextScope: AgentContextScope;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
  systemPrompt: string;
  appendMode: boolean;
  tools: string[] | null; // null = inherit all
  allowedSubagents: string[];
  lastN: number | null;
  recallK: number | null;
  projects: string[];
}

function toAgentDto(a: Agent, projects: readonly string[] = []): AgentDto {
  let assets: AgentAssets;
  try {
    assets = loadAgentAssets(a.name);
  } catch {
    assets = {
      systemPrompt: { prompt: "", append: false },
      memory: { lastN: null, recallK: null },
      tools: undefined,
      allowedSubagents: [],
    };
  }
  return {
    name: a.name,
    description: a.description,
    visibility: a.visibility,
    isSubagent: a.isSubagent,
    knowsOtherAgents: a.knowsOtherAgents,
    contextScope: a.contextScope,
    createdBy: a.createdBy,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    systemPrompt: assets.systemPrompt.prompt,
    appendMode: assets.systemPrompt.append,
    tools: assets.tools === undefined ? null : [...assets.tools],
    allowedSubagents: [...assets.allowedSubagents],
    lastN: assets.memory.lastN,
    recallK: assets.memory.recallK,
    projects: [...projects],
  };
}

function canSeeAgent(a: Agent, user: User): boolean {
  if (a.visibility === "public") return true;
  if (user.role === "admin") return true;
  return a.createdBy === user.id;
}

function canEditAgent(a: Agent, user: User): boolean {
  if (user.role === "admin") return true;
  return a.createdBy === user.id;
}

interface AgentBody {
  name?: string;
  description?: string | null;
  visibility?: AgentVisibility;
  isSubagent?: boolean;
  knowsOtherAgents?: boolean;
  contextScope?: AgentContextScope;
  systemPrompt?: string;
  appendMode?: boolean;
  tools?: string[] | null;
  allowedSubagents?: string[];
  lastN?: number | null;
  recallK?: number | null;
}

async function handleCreateAgent(req: Request, ctx: AgentRouteCtx, user: User): Promise<Response> {
  let body: AgentBody;
  try {
    body = (await req.json()) as AgentBody;
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  try {
    const name = validateAgentName(body.name ?? "");
    if (getAgent(ctx.db, name)) return json({ error: `agent '${name}' already exists` }, 409);
    const created = createAgent(ctx.db, {
      name,
      description: body.description ?? "",
      visibility: body.visibility === "public" ? "public" : "private",
      isSubagent: body.isSubagent === true,
      knowsOtherAgents: body.knowsOtherAgents === true,
      contextScope: body.contextScope === "own" ? "own" : "full",
      createdBy: user.id,
    });
    ensureAgentDir(name);
    writeAgentAssets(name, {
      systemPrompt: { prompt: body.systemPrompt ?? "", append: body.appendMode === true },
      memory: {
        lastN: parseMemoryOverride(body.lastN),
        recallK: parseMemoryOverride(body.recallK),
      },
      tools: body.tools === null ? null : sanitiseToolList(body.tools),
      allowedSubagents: sanitiseNameList(body.allowedSubagents),
    });
    // Auto-link every new agent to the default project so a @mention in the
    // default chat works out of the box. The operator can unlink afterwards.
    if (getProject(ctx.db, ctx.defaultProject)) {
      linkAgentToProject(ctx.db, ctx.defaultProject, name);
    }
    return json({ agent: toAgentDto(created, listProjectsForAgent(ctx.db, name)) }, 201);
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

function handleGetAgent(ctx: AgentRouteCtx, user: User, name: string): Response {
  const a = getAgent(ctx.db, name);
  if (!a) return json({ error: "not found" }, 404);
  if (!canSeeAgent(a, user)) return json({ error: "forbidden" }, 403);
  return json({ agent: toAgentDto(a, listProjectsForAgent(ctx.db, a.name)) });
}

async function handlePatchAgent(
  req: Request,
  ctx: AgentRouteCtx,
  user: User,
  name: string,
): Promise<Response> {
  const existing = getAgent(ctx.db, name);
  if (!existing) return json({ error: "not found" }, 404);
  if (!canEditAgent(existing, user)) return json({ error: "forbidden" }, 403);
  let body: AgentBody;
  try {
    body = (await req.json()) as AgentBody;
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  try {
    const updated = updateAgent(ctx.db, name, {
      description: body.description ?? undefined,
      visibility: body.visibility,
      isSubagent: body.isSubagent,
      knowsOtherAgents: body.knowsOtherAgents,
      contextScope: body.contextScope,
    });
    const touchesPrompt = body.systemPrompt !== undefined || body.appendMode !== undefined;
    const touchesMemory = body.lastN !== undefined || body.recallK !== undefined;
    const touchesTools = body.tools !== undefined;
    const touchesSubs = body.allowedSubagents !== undefined;
    if (touchesPrompt || touchesMemory || touchesTools || touchesSubs) {
      const sp: Partial<{ prompt: string; append: boolean }> = {};
      if (body.systemPrompt !== undefined) sp.prompt = body.systemPrompt;
      if (body.appendMode !== undefined) sp.append = body.appendMode;
      const memory = touchesMemory
        ? {
            ...(body.lastN !== undefined ? { lastN: parseMemoryOverride(body.lastN) } : {}),
            ...(body.recallK !== undefined ? { recallK: parseMemoryOverride(body.recallK) } : {}),
          }
        : undefined;
      writeAgentAssets(name, {
        systemPrompt: sp,
        memory,
        tools: touchesTools ? (body.tools === null ? null : sanitiseToolList(body.tools)) : undefined,
        allowedSubagents: touchesSubs ? sanitiseNameList(body.allowedSubagents) : undefined,
      });
    }
    return json({ agent: toAgentDto(updated, listProjectsForAgent(ctx.db, name)) });
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

function handleDeleteAgent(ctx: AgentRouteCtx, user: User, name: string): Response {
  const a = getAgent(ctx.db, name);
  if (!a) return json({ error: "not found" }, 404);
  if (!canEditAgent(a, user)) return json({ error: "forbidden" }, 403);
  try {
    deleteAgent(ctx.db, name);
    return json({ ok: true });
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

function handleListProjectAgents(ctx: AgentRouteCtx, user: User, rawProject: string): Response {
  let project: string;
  try {
    project = validateProjectName(rawProject);
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
  const p = getProject(ctx.db, project);
  if (!p) return json({ error: "project not found" }, 404);
  if (p.visibility === "private" && user.role !== "admin" && p.createdBy !== user.id) {
    return json({ error: "forbidden" }, 403);
  }
  const agents = listAgentsForProject(ctx.db, project).filter((a) => canSeeAgent(a, user));
  const projectMap = mapProjectsByAgent(ctx.db);
  return json({ agents: agents.map((a) => toAgentDto(a, projectMap.get(a.name) ?? [])) });
}

async function handleLinkAgent(
  req: Request,
  ctx: AgentRouteCtx,
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
  if (user.role !== "admin" && p.createdBy !== user.id) {
    return json({ error: "forbidden" }, 403);
  }
  let body: { agent?: string };
  try {
    body = (await req.json()) as { agent?: string };
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  try {
    const agent = validateAgentName(body.agent ?? "");
    if (!getAgent(ctx.db, agent)) return json({ error: "agent not found" }, 404);
    linkAgentToProject(ctx.db, project, agent);
    return json({ ok: true });
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

function handleUnlinkAgent(
  ctx: AgentRouteCtx,
  user: User,
  rawProject: string,
  rawAgent: string,
): Response {
  let project: string;
  let agent: string;
  try {
    project = validateProjectName(rawProject);
    agent = validateAgentName(rawAgent);
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
  const p = getProject(ctx.db, project);
  if (!p) return json({ error: "project not found" }, 404);
  if (user.role !== "admin" && p.createdBy !== user.id) {
    return json({ error: "forbidden" }, 403);
  }
  unlinkAgentFromProject(ctx.db, project, agent);
  return json({ ok: true });
}

function sanitiseToolList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  // Mirror `/api/tools`: real registry tools (minus call_agent) plus the
  // closure-bound board tool names. call_agent stays implicit via
  // allowed_subagents.
  const known = new Set<string>([
    ...registry.names().filter((n) => n !== CALL_AGENT_TOOL_NAME),
    ...BOARD_TOOL_NAMES,
  ]);
  return raw
    .filter((x): x is string => typeof x === "string")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && known.has(s));
}

function sanitiseNameList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is string => typeof x === "string")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^[a-z0-9][a-z0-9_-]{0,62}$/.test(s));
}
