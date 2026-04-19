/**
 * Trash bin routes (admin-only). Thin wrapper around `src/memory/trash.ts`:
 * every mutation logs through the queue with topic `trash`.
 */

import type { Database } from "bun:sqlite";
import type { User } from "../auth/users.ts";
import type { BunnyQueue } from "../queue/bunqueue.ts";
import { json } from "./http.ts";
import {
  getTrashDef,
  hardDelete,
  listTrash,
  restore,
  type TrashKind,
} from "../memory/trash.ts";

function parseTrashKind(raw: string): TrashKind | undefined {
  return getTrashDef(raw)?.kind;
}

export interface TrashRouteCtx {
  db: Database;
  queue: BunnyQueue;
}

export async function handleTrashRoute(
  req: Request,
  url: URL,
  ctx: TrashRouteCtx,
  user: User,
): Promise<Response | null> {
  const { pathname } = url;
  if (!pathname.startsWith("/api/trash")) return null;

  // Every trash endpoint is admin-only — the bin spans every user's content.
  if (user.role !== "admin") return json({ error: "forbidden" }, 403);

  if (pathname === "/api/trash" && req.method === "GET") {
    return json({ items: listTrash(ctx.db) });
  }

  const restoreMatch = pathname.match(
    /^\/api\/trash\/([^/]+)\/(\d+)\/restore$/,
  );
  if (restoreMatch) {
    if (req.method !== "POST")
      return json({ error: "method not allowed" }, 405);
    return handleRestore(ctx, user, restoreMatch[1]!, Number(restoreMatch[2]));
  }

  const itemMatch = pathname.match(/^\/api\/trash\/([^/]+)\/(\d+)$/);
  if (itemMatch) {
    if (req.method !== "DELETE")
      return json({ error: "method not allowed" }, 405);
    return handleHardDelete(ctx, user, itemMatch[1]!, Number(itemMatch[2]));
  }

  return null;
}

function handleRestore(
  ctx: TrashRouteCtx,
  user: User,
  rawKind: string,
  id: number,
): Response {
  const kind = parseTrashKind(rawKind);
  if (!kind) return json({ error: "unknown kind" }, 400);

  const outcome = restore(ctx.db, kind, id);
  if (outcome === "not_found") return json({ error: "not_found" }, 404);
  if (outcome === "name_conflict") return json({ error: "name_conflict" }, 409);

  void ctx.queue.log({
    topic: "trash",
    kind: "restore",
    userId: user.id,
    data: { kind, id },
  });
  return json({ ok: true });
}

function handleHardDelete(
  ctx: TrashRouteCtx,
  user: User,
  rawKind: string,
  id: number,
): Response {
  const kind = parseTrashKind(rawKind);
  if (!kind) return json({ error: "unknown kind" }, 400);

  if (!hardDelete(ctx.db, kind, id)) return json({ error: "not_found" }, 404);

  void ctx.queue.log({
    topic: "trash",
    kind: "hard_delete",
    userId: user.id,
    data: { kind, id },
  });
  return json({ ok: true });
}
