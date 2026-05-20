/**
 * Entity-versions HTTP API. Generic over `kind` — every registered
 * `VersionableEntityDef` is reachable through the same four endpoints:
 *
 *   GET  /api/versions/:kind/:entityId            → VersionMeta[]
 *   GET  /api/versions/:kind/:entityId/count      → { count } (badge dot)
 *   GET  /api/versions/:kind/:entityId/:version   → VersionDetail (parsed snapshot)
 *   POST /api/versions/:kind/:entityId/restore    → body { version }
 *
 * Permissions:
 *   - Admins bypass per-kind checks unconditionally.
 *   - Non-admins go through the kind's `canSee` / `canEdit` callbacks. A
 *     missing callback denies (effectively admin-only for that kind), which
 *     is the safe default — registrations can opt in incrementally.
 *
 * `entityId` is taken as a raw string segment from the URL (decoded by the
 * platform) and forwarded as-is to the versioning layer — agents/skills use
 * slug ids, the rest use integer ids. The versioning module casts via
 * `String(id)` internally.
 */

import type { Database } from "bun:sqlite";
import type { User } from "../auth/users.ts";
import type { BunnyQueue } from "../queue/bunqueue.ts";
import { json, readJson } from "./http.ts";
import {
  errorMessage,
  errorStatus,
  logUnexpectedError,
} from "../util/error.ts";
import {
  countVersions,
  getVersion,
  getVersionableDef,
  listVersions,
  restoreVersion,
  type VersionableKind,
} from "../memory/versioning.ts";

export interface VersionsRouteCtx {
  db: Database;
  queue: BunnyQueue;
}

/**
 * Resolve `kind` + permission for a request. Admins always pass; non-admins
 * go through the kind's `canSee` / `canEdit` callback (whichever the caller
 * names via `access`). Returns the typed kind on success, or a response that
 * the caller must surface unchanged.
 */
function authorize(
  ctx: VersionsRouteCtx,
  user: User,
  rawKind: string,
  entityId: string,
  access: "see" | "edit",
): { ok: true; kind: VersionableKind } | { ok: false; res: Response } {
  if (rawKind === "__test__") {
    return { ok: false, res: json({ error: "unknown kind" }, 400) };
  }
  const def = getVersionableDef(rawKind);
  if (!def) return { ok: false, res: json({ error: "unknown kind" }, 400) };
  if (user.role === "admin") return { ok: true, kind: def.kind };
  const check = access === "see" ? def.canSee : def.canEdit;
  if (!check || !check(ctx.db, user.id, entityId)) {
    return { ok: false, res: json({ error: "forbidden" }, 403) };
  }
  return { ok: true, kind: def.kind };
}

export async function handleVersionsRoute(
  req: Request,
  url: URL,
  ctx: VersionsRouteCtx,
  user: User,
): Promise<Response | null> {
  const { pathname } = url;
  if (!pathname.startsWith("/api/versions/")) return null;

  // /api/versions/:kind/:entityId/restore  (POST)
  const restoreMatch = pathname.match(
    /^\/api\/versions\/([^/]+)\/([^/]+)\/restore$/,
  );
  if (restoreMatch) {
    if (req.method !== "POST")
      return json({ error: "method not allowed" }, 405);
    return handleRestore(ctx, user, restoreMatch[1]!, restoreMatch[2]!, req);
  }

  // /api/versions/:kind/:entityId/count   (GET)
  const countMatch = pathname.match(
    /^\/api\/versions\/([^/]+)\/([^/]+)\/count$/,
  );
  if (countMatch) {
    if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
    return handleCount(ctx, user, countMatch[1]!, countMatch[2]!);
  }

  // /api/versions/:kind/:entityId/:version (GET)
  const detailMatch = pathname.match(
    /^\/api\/versions\/([^/]+)\/([^/]+)\/(\d+)$/,
  );
  if (detailMatch) {
    if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
    return handleGet(
      ctx,
      user,
      detailMatch[1]!,
      detailMatch[2]!,
      Number(detailMatch[3]),
    );
  }

  // /api/versions/:kind/:entityId          (GET)
  const listMatch = pathname.match(/^\/api\/versions\/([^/]+)\/([^/]+)$/);
  if (listMatch) {
    if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
    return handleList(ctx, user, listMatch[1]!, listMatch[2]!);
  }

  return null;
}

function handleList(
  ctx: VersionsRouteCtx,
  user: User,
  rawKind: string,
  entityId: string,
): Response {
  const auth = authorize(ctx, user, rawKind, entityId, "see");
  if (!auth.ok) return auth.res;
  return json({ versions: listVersions(ctx.db, auth.kind, entityId) });
}

function handleCount(
  ctx: VersionsRouteCtx,
  user: User,
  rawKind: string,
  entityId: string,
): Response {
  const auth = authorize(ctx, user, rawKind, entityId, "see");
  if (!auth.ok) return auth.res;
  return json({ count: countVersions(ctx.db, auth.kind, entityId) });
}

function handleGet(
  ctx: VersionsRouteCtx,
  user: User,
  rawKind: string,
  entityId: string,
  version: number,
): Response {
  const auth = authorize(ctx, user, rawKind, entityId, "see");
  if (!auth.ok) return auth.res;
  const detail = getVersion(ctx.db, auth.kind, entityId, version);
  if (!detail) return json({ error: "not found" }, 404);
  return json({ version: detail });
}

async function handleRestore(
  ctx: VersionsRouteCtx,
  user: User,
  rawKind: string,
  entityId: string,
  req: Request,
): Promise<Response> {
  const auth = authorize(ctx, user, rawKind, entityId, "edit");
  if (!auth.ok) return auth.res;
  const body = await readJson<{ version?: number }>(req);
  const version = body?.version;
  if (typeof version !== "number" || !Number.isFinite(version) || version < 1) {
    return json({ error: "missing or invalid 'version'" }, 400);
  }
  try {
    restoreVersion(ctx.db, auth.kind, entityId, version, user.id);
  } catch (e) {
    logUnexpectedError(ctx.queue, e, "POST /api/versions/.../restore");
    return json({ error: errorMessage(e) }, errorStatus(e, 400));
  }
  void ctx.queue.log({
    topic: "versions",
    kind: "restore",
    userId: user.id,
    data: { kind: auth.kind, entityId, version },
  });
  return json({ ok: true });
}
