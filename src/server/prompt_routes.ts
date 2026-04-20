/**
 * Prompt-registry routes.
 *
 *   GET  /api/config/prompts       — admin only. Returns every prompt
 *                                    (global + projectOverridable) with
 *                                    metadata + current effective text.
 *   PUT  /api/config/prompts       — admin only. Body { key, text: string|null }.
 *                                    text=null removes the global override.
 *
 *   GET  /api/projects/:name/prompts  — admin or project creator. Only the
 *                                       projectOverridable entries.
 *   PUT  /api/projects/:name/prompts  — admin or project creator.
 *
 * All mutations log via the queue under topic `"prompts"`.
 */

import type { Database } from "bun:sqlite";
import type { User } from "../auth/users.ts";
import type { BunnyQueue } from "../queue/bunqueue.ts";
import { json, readJson } from "./http.ts";
import { PROMPTS, PROMPT_KEYS, type PromptDef } from "../prompts/registry.ts";
import {
  loadGlobalPromptOverrides,
  setGlobalPromptOverride,
} from "../prompts/global_overrides.ts";
import {
  loadProjectPromptOverrides,
  setProjectPromptOverride,
} from "../memory/prompt_overrides.ts";
import { getProject, validateProjectName } from "../memory/projects.ts";

export interface PromptRouteCtx {
  db: Database;
  queue: BunnyQueue;
}

interface PromptDto {
  key: string;
  scope: PromptDef["scope"];
  description: string;
  defaultText: string;
  variables?: string[];
  warnsJsonContract?: boolean;
  warnsTokenCost?: boolean;
  global: string | null;
  /** Project-level override text (null when unset or not applicable). */
  override: string | null;
  /** The text that will actually be sent to the LLM. */
  effective: string;
  isOverridden: boolean;
}

const MAX_PROMPT_BYTES = 64 * 1024;

export async function handlePromptRoute(
  req: Request,
  url: URL,
  ctx: PromptRouteCtx,
  user: User,
): Promise<Response | null> {
  const { pathname } = url;

  // ── Global prompts (admin-only) ─────────────────────────────────────────────
  if (pathname === "/api/config/prompts") {
    if (user.role !== "admin") return json({ error: "forbidden" }, 403);
    if (req.method === "GET") return handleListGlobal();
    if (req.method === "PUT") return handleSetGlobal(req, ctx, user);
    return json({ error: "method not allowed" }, 405);
  }

  // ── Per-project prompts ─────────────────────────────────────────────────────
  const match = pathname.match(/^\/api\/projects\/([^/]+)\/prompts$/);
  if (match) {
    const rawName = decodeURIComponent(match[1]!);
    let name: string;
    try {
      name = validateProjectName(rawName);
    } catch {
      return json({ error: "invalid project name" }, 400);
    }
    const project = getProject(ctx.db, name);
    if (!project) return json({ error: "not found" }, 404);
    if (!canEditProjectPrompts(user, project.createdBy)) {
      return json({ error: "forbidden" }, 403);
    }
    if (req.method === "GET") return handleListProject(name);
    if (req.method === "PUT") return handleSetProject(req, ctx, user, name);
    return json({ error: "method not allowed" }, 405);
  }

  return null;
}

function canEditProjectPrompts(user: User, createdBy: string | null): boolean {
  if (user.role === "admin") return true;
  return createdBy !== null && createdBy === user.id;
}

function buildDto(
  def: PromptDef,
  globals: Record<string, string>,
  projectOverrides: Record<string, string> | null,
): PromptDto {
  const globalText = globals[def.key] ?? null;
  const projectText =
    projectOverrides && def.scope === "projectOverridable"
      ? projectOverrides[def.key] ?? null
      : null;
  const effective = projectText ?? globalText ?? def.defaultText;
  const dto: PromptDto = {
    key: def.key,
    scope: def.scope,
    description: def.description,
    defaultText: def.defaultText,
    global: globalText,
    override: projectText,
    effective,
    isOverridden: projectText !== null || globalText !== null,
  };
  if (def.variables) dto.variables = def.variables;
  if (def.warnsJsonContract) dto.warnsJsonContract = true;
  if (def.warnsTokenCost) dto.warnsTokenCost = true;
  return dto;
}

function handleListGlobal(): Response {
  const globals = loadGlobalPromptOverrides();
  const prompts = PROMPT_KEYS.map((k) => buildDto(PROMPTS[k]!, globals, null));
  return json({ prompts });
}

function handleListProject(name: string): Response {
  const globals = loadGlobalPromptOverrides();
  const projectOverrides = loadProjectPromptOverrides(name);
  const prompts = PROMPT_KEYS.filter(
    (k) => PROMPTS[k]!.scope === "projectOverridable",
  ).map((k) => buildDto(PROMPTS[k]!, globals, projectOverrides));
  return json({ prompts });
}

async function handleSetGlobal(
  req: Request,
  ctx: PromptRouteCtx,
  user: User,
): Promise<Response> {
  const body = await readJson<{ key?: unknown; text?: unknown }>(req);
  if (!body) return json({ error: "invalid json" }, 400);
  const key = typeof body.key === "string" ? body.key : "";
  if (!(key in PROMPTS)) return json({ error: "unknown prompt key" }, 400);
  const text = parseTextField(body.text);
  if (text === "too_long") {
    return json({ error: "text too long" }, 413);
  }
  if (text === "invalid") {
    return json({ error: "text must be string or null" }, 400);
  }
  setGlobalPromptOverride(key, text);
  void ctx.queue.log({
    topic: "prompts",
    kind: "global.set",
    userId: user.id,
    data: {
      key,
      length: text === null ? 0 : text.length,
      cleared: text === null,
    },
  });
  return json({ ok: true });
}

async function handleSetProject(
  req: Request,
  ctx: PromptRouteCtx,
  user: User,
  project: string,
): Promise<Response> {
  const body = await readJson<{ key?: unknown; text?: unknown }>(req);
  if (!body) return json({ error: "invalid json" }, 400);
  const key = typeof body.key === "string" ? body.key : "";
  const def = PROMPTS[key];
  if (!def) return json({ error: "unknown prompt key" }, 400);
  if (def.scope !== "projectOverridable") {
    return json({ error: "key is not project-overridable" }, 400);
  }
  const text = parseTextField(body.text);
  if (text === "too_long") {
    return json({ error: "text too long" }, 413);
  }
  if (text === "invalid") {
    return json({ error: "text must be string or null" }, 400);
  }
  setProjectPromptOverride(project, key, text);
  void ctx.queue.log({
    topic: "prompts",
    kind: "project.set",
    userId: user.id,
    data: {
      project,
      key,
      length: text === null ? 0 : text.length,
      cleared: text === null,
    },
  });
  return json({ ok: true });
}

function parseTextField(raw: unknown): string | null | "invalid" | "too_long" {
  if (raw === null) return null;
  if (typeof raw !== "string") return "invalid";
  if (raw.length > MAX_PROMPT_BYTES) return "too_long";
  return raw;
}
