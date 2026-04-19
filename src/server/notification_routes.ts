/**
 * HTTP routes for per-user notifications.
 *
 * Mounted in `routes.ts:handleApi` after translation routes and before the
 * scheduler. Every route scopes by the authenticated user's id; reading
 * another user's notification returns 404 rather than 403 so the existence
 * of the row isn't revealed.
 *
 * Surface (v1):
 *   - GET    /api/notifications              → list + unread count
 *   - PATCH  /api/notifications/:id/read     → mark one read
 *   - POST   /api/notifications/mark-all-read
 *   - DELETE /api/notifications/:id
 *   - GET    /api/notifications/stream       → SSE, per-user fanout
 */

import type { Database } from "bun:sqlite";
import type { BunnyConfig } from "../config.ts";
import type { BunnyQueue } from "../queue/bunqueue.ts";
import type { User } from "../auth/users.ts";
import { controllerSink, type SseSink } from "../agent/render_sse.ts";
import { json } from "./http.ts";
import {
  deleteNotification as deleteNotificationRow,
  getNotification,
  getUnreadCount,
  listForUser,
  markAllRead as markAllReadRow,
  markRead as markReadRow,
  notificationToDto,
} from "../memory/notifications.ts";
import { publish, subscribeUser } from "../notifications/fanout.ts";

export interface NotificationRouteCtx {
  db: Database;
  queue: BunnyQueue;
  cfg: BunnyConfig;
}

export async function handleNotificationRoute(
  req: Request,
  url: URL,
  ctx: NotificationRouteCtx,
  user: User,
): Promise<Response | null> {
  const { pathname } = url;

  if (pathname === "/api/notifications/stream" && req.method === "GET") {
    return handleStream(user);
  }

  if (pathname === "/api/notifications" && req.method === "GET") {
    return handleList(ctx, user, url);
  }

  if (
    pathname === "/api/notifications/mark-all-read" &&
    req.method === "POST"
  ) {
    return handleMarkAllRead(ctx, user);
  }

  const readMatch = pathname.match(/^\/api\/notifications\/(\d+)\/read$/);
  if (readMatch) {
    if (req.method !== "PATCH") return null;
    return handleMarkRead(ctx, user, Number(readMatch[1]));
  }

  const idMatch = pathname.match(/^\/api\/notifications\/(\d+)$/);
  if (idMatch) {
    if (req.method !== "DELETE") return null;
    return handleDelete(ctx, user, Number(idMatch[1]));
  }

  return null;
}

function handleList(ctx: NotificationRouteCtx, user: User, url: URL): Response {
  const unreadOnly = url.searchParams.get("unread") === "1";
  const limitRaw = Number(url.searchParams.get("limit"));
  const beforeRaw = Number(url.searchParams.get("before"));
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;
  const before =
    Number.isFinite(beforeRaw) && beforeRaw > 0 ? beforeRaw : undefined;
  const items = listForUser(ctx.db, user.id, { unreadOnly, limit, before }).map(
    notificationToDto,
  );
  const unreadCount = getUnreadCount(ctx.db, user.id);
  return json({ items, unreadCount });
}

function handleMarkRead(
  ctx: NotificationRouteCtx,
  user: User,
  id: number,
): Response {
  // Ownership check — surface 404 rather than 403 so the existence of another
  // user's row isn't revealed.
  const row = getNotification(ctx.db, id);
  if (!row || row.userId !== user.id) return json({ error: "not found" }, 404);

  const readAt = markReadRow(ctx.db, id, user.id);
  if (readAt != null) {
    void ctx.queue.log({
      topic: "notification",
      kind: "read",
      userId: user.id,
      data: { notifId: id },
    });
    publish(user.id, {
      type: "notification_read",
      ids: [id],
      readAt,
    });
  }
  const unreadCount = getUnreadCount(ctx.db, user.id);
  return json({ ok: true, unreadCount });
}

function handleMarkAllRead(ctx: NotificationRouteCtx, user: User): Response {
  const readAt = markAllReadRow(ctx.db, user.id);
  void ctx.queue.log({
    topic: "notification",
    kind: "read_all",
    userId: user.id,
  });
  publish(user.id, { type: "notification_read", ids: [], readAt });
  return json({ ok: true, unreadCount: 0 });
}

function handleDelete(
  ctx: NotificationRouteCtx,
  user: User,
  id: number,
): Response {
  const ok = deleteNotificationRow(ctx.db, id, user.id);
  if (!ok) return json({ error: "not found" }, 404);
  void ctx.queue.log({
    topic: "notification",
    kind: "delete",
    userId: user.id,
    data: { notifId: id },
  });
  const unreadCount = getUnreadCount(ctx.db, user.id);
  return json({ ok: true, unreadCount });
}

function handleStream(user: User): Response {
  let unsubscribe: (() => void) | null = null;
  let theSink: SseSink | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const sink = controllerSink(controller);
      theSink = sink;
      // Nudge the connection into a known-good state so clients can detect
      // the stream opened. Comment line — ignored by the frame parser.
      sink.enqueue(new TextEncoder().encode(`: open\n\n`));
      unsubscribe = subscribeUser(user.id, sink);
    },
    cancel() {
      unsubscribe?.();
      theSink?.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
