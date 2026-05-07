/**
 * HTTP routes for code-project secrets.
 *
 *   GET    /api/code/:id/secrets              list secrets (values masked when not viewable)
 *   GET    /api/code/:id/secrets/names        names + descriptions only (for Monaco IntelliSense)
 *   POST   /api/code/:id/secrets              create secret (admin / project editor)
 *   PATCH  /api/code/:id/secrets/:secretId    update secret (admin / project editor)
 *   DELETE /api/code/:id/secrets/:secretId    delete secret (admin / project editor)
 *
 * See ADR 0039.
 */

import type { Database } from "bun:sqlite";
import type { BunnyQueue } from "../queue/bunqueue.ts";
import type { User } from "../auth/users.ts";
import { errorMessage } from "../util/error.ts";
import { json, readJson } from "./http.ts";
import { canSeeProject } from "./route_helpers.ts";
import { getProject } from "../memory/projects.ts";
import { canEditCodeProject, getCodeProject } from "../memory/code_projects.ts";
import {
  listSecrets,
  listSecretNames,
  getSecret,
  createSecret,
  updateSecret,
  deleteSecret,
  type CodeProjectSecret,
} from "../memory/code_project_secrets.ts";

export interface SecretRouteCtx {
  db: Database;
  queue: BunnyQueue;
}

export async function handleSecretRoute(
  req: Request,
  url: URL,
  ctx: SecretRouteCtx,
  user: User,
): Promise<Response | null> {
  const { pathname } = url;

  // /api/code/:id/secrets/names  (must match before the broader /secrets pattern)
  const namesMatch = pathname.match(/^\/api\/code\/(\d+)\/secrets\/names$/);
  if (namesMatch) {
    const id = Number(namesMatch[1]);
    if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
    return handleListNames(ctx, user, id);
  }

  // /api/code/:id/secrets
  const listMatch = pathname.match(/^\/api\/code\/(\d+)\/secrets$/);
  if (listMatch) {
    const id = Number(listMatch[1]);
    if (req.method === "GET") return handleList(ctx, user, id);
    if (req.method === "POST") return handleCreate(req, ctx, user, id);
    return json({ error: "method not allowed" }, 405);
  }

  // /api/code/:id/secrets/:secretId
  const itemMatch = pathname.match(/^\/api\/code\/(\d+)\/secrets\/(\d+)$/);
  if (itemMatch) {
    const id = Number(itemMatch[1]);
    const secretId = Number(itemMatch[2]);
    if (req.method === "PATCH") return handleUpdate(req, ctx, user, id, secretId);
    if (req.method === "DELETE") return handleDelete(ctx, user, id, secretId);
    return json({ error: "method not allowed" }, 405);
  }

  return null;
}

// ── Response shape ────────────────────────────────────────────────────────────

function toDto(secret: CodeProjectSecret, isAdmin: boolean) {
  return {
    id: secret.id,
    codeProjectId: secret.codeProjectId,
    name: secret.name,
    description: secret.description,
    // Value is null for non-admins when the secret is not marked as viewable.
    value: isAdmin || secret.isViewable ? secret.value : null,
    isViewable: secret.isViewable,
    llmForbidden: secret.llmForbidden,
    lastUsedAt: secret.lastUsedAt,
    createdBy: secret.createdBy,
    createdAt: secret.createdAt,
    updatedAt: secret.updatedAt,
  };
}

// ── Handlers ─────────────────────────────────────────────────────────────────

function handleList(
  ctx: SecretRouteCtx,
  user: User,
  codeProjectId: number,
): Response {
  const cp = getCodeProject(ctx.db, codeProjectId);
  if (!cp) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, cp.project);
  if (!p) return json({ error: "project not found" }, 404);
  if (!canSeeProject(p, user)) return json({ error: "forbidden" }, 403);
  const isAdmin = canEditCodeProject(user, cp, p);

  const secrets = listSecrets(ctx.db, codeProjectId);
  return json({ secrets: secrets.map((s) => toDto(s, isAdmin)) });
}

function handleListNames(
  ctx: SecretRouteCtx,
  user: User,
  codeProjectId: number,
): Response {
  const cp = getCodeProject(ctx.db, codeProjectId);
  if (!cp) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, cp.project);
  if (!p) return json({ error: "project not found" }, 404);
  if (!canSeeProject(p, user)) return json({ error: "forbidden" }, 403);

  return json({ names: listSecretNames(ctx.db, codeProjectId) });
}

async function handleCreate(
  req: Request,
  ctx: SecretRouteCtx,
  user: User,
  codeProjectId: number,
): Promise<Response> {
  const cp = getCodeProject(ctx.db, codeProjectId);
  if (!cp) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, cp.project);
  if (!p) return json({ error: "project not found" }, 404);
  if (!canSeeProject(p, user)) return json({ error: "forbidden" }, 403);
  const isAdmin = canEditCodeProject(user, cp, p);
  if (!isAdmin) return json({ error: "forbidden" }, 403);

  const body = await readJson<{
    name?: string;
    description?: string;
    value?: string;
    isViewable?: boolean;
    llmForbidden?: boolean;
  }>(req);
  if (!body) return json({ error: "invalid json" }, 400);
  if (typeof body.name !== "string" || !body.name.trim())
    return json({ error: "name is required" }, 400);
  if (typeof body.value !== "string" || !body.value)
    return json({ error: "value is required" }, 400);

  try {
    const secret = createSecret(ctx.db, {
      codeProjectId,
      name: body.name.trim(),
      description: body.description ?? "",
      value: body.value,
      isViewable: body.isViewable ?? false,
      llmForbidden: body.llmForbidden ?? false,
      createdBy: user.id,
    });

    void ctx.queue.log({
      topic: "secrets",
      kind: "create",
      userId: user.id,
      data: { id: secret.id, codeProjectId, name: secret.name },
    });

    return json({ secret: toDto(secret, true) }, 201);
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

async function handleUpdate(
  req: Request,
  ctx: SecretRouteCtx,
  user: User,
  codeProjectId: number,
  secretId: number,
): Promise<Response> {
  const cp = getCodeProject(ctx.db, codeProjectId);
  if (!cp) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, cp.project);
  if (!p) return json({ error: "project not found" }, 404);
  if (!canSeeProject(p, user)) return json({ error: "forbidden" }, 403);
  if (!canEditCodeProject(user, cp, p)) return json({ error: "forbidden" }, 403);

  const existing = getSecret(ctx.db, secretId);
  if (!existing) return json({ error: "not found" }, 404);
  if (existing.codeProjectId !== codeProjectId)
    return json({ error: "not found" }, 404);

  const body = await readJson<{
    name?: string;
    description?: string;
    value?: string;
    isViewable?: boolean;
    llmForbidden?: boolean;
  }>(req);
  if (!body) return json({ error: "invalid json" }, 400);

  try {
    const updated = updateSecret(ctx.db, secretId, {
      name: typeof body.name === "string" ? body.name.trim() : undefined,
      description:
        typeof body.description === "string" ? body.description : undefined,
      value: typeof body.value === "string" ? body.value : undefined,
      isViewable:
        typeof body.isViewable === "boolean" ? body.isViewable : undefined,
      llmForbidden:
        typeof body.llmForbidden === "boolean" ? body.llmForbidden : undefined,
    });
    if (!updated) return json({ error: "not found" }, 404);

    void ctx.queue.log({
      topic: "secrets",
      kind: "update",
      userId: user.id,
      data: { id: secretId, codeProjectId, name: updated.name },
    });

    return json({ secret: toDto(updated, true) });
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

function handleDelete(
  ctx: SecretRouteCtx,
  user: User,
  codeProjectId: number,
  secretId: number,
): Response {
  const cp = getCodeProject(ctx.db, codeProjectId);
  if (!cp) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, cp.project);
  if (!p) return json({ error: "project not found" }, 404);
  if (!canSeeProject(p, user)) return json({ error: "forbidden" }, 403);
  if (!canEditCodeProject(user, cp, p)) return json({ error: "forbidden" }, 403);

  const existing = getSecret(ctx.db, secretId);
  if (!existing) return json({ error: "not found" }, 404);
  if (existing.codeProjectId !== codeProjectId)
    return json({ error: "not found" }, 404);

  deleteSecret(ctx.db, secretId);

  void ctx.queue.log({
    topic: "secrets",
    kind: "delete",
    userId: user.id,
    data: { id: secretId, codeProjectId, name: existing.name },
  });

  return json({ ok: true });
}
