/**
 * HTTP routes for the Bunny web UI.
 *
 * Thin adapter — each route delegates to existing memory / agent modules.
 * Plain switch on `pathname` keeps us framework-free.
 */

import type { Database } from "bun:sqlite";
import type { BunnyConfig } from "../config.ts";
import type { BunnyQueue } from "../queue/bunqueue.ts";
import { randomUUID } from "node:crypto";

import { getMessagesBySession } from "../memory/messages.ts";
import { getSessionOwners, listSessions } from "../memory/sessions.ts";
import { runAgent } from "../agent/loop.ts";
import { createSseRenderer, controllerSink, finishSse } from "../agent/render_sse.ts";
import { registry } from "../tools/index.ts";
import { errorMessage } from "../util/error.ts";
import { authenticate } from "./auth_middleware.ts";
import { handleAuthRoute } from "./auth_routes.ts";
import { json } from "./http.ts";
import type { User } from "../auth/users.ts";

export interface RouteCtx {
  db: Database;
  queue: BunnyQueue;
  cfg: BunnyConfig;
}

export async function handleApi(req: Request, url: URL, ctx: RouteCtx): Promise<Response> {
  const { pathname } = url;

  // Auth / user / apikey routes take precedence.
  const authResponse = await handleAuthRoute(req, url, ctx);
  if (authResponse) return authResponse;

  // All remaining /api/* routes require an authenticated user.
  const user = await authenticate(ctx.db, req);
  if (!user) return json({ error: "unauthorized" }, 401);

  // GET /api/sessions?q=...&scope=mine|all
  if (pathname === "/api/sessions" && req.method === "GET") {
    const q = url.searchParams.get("q") ?? undefined;
    const scope = url.searchParams.get("scope") ?? "mine";
    // Admins may opt-in to the global view with scope=all; everyone else is
    // always restricted to their own sessions.
    const allowAll = user.role === "admin" && scope === "all";
    const filter = allowAll ? {} : { userId: user.id };
    const sessions = listSessions(ctx.db, { search: q, ...filter });
    return json({ sessions });
  }

  // POST /api/sessions → create a new session id
  if (pathname === "/api/sessions" && req.method === "POST") {
    return json({ sessionId: randomUUID() }, 201);
  }

  // GET /api/sessions/:id/messages
  const msgMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
  if (msgMatch && req.method === "GET") {
    const sessionId = decodeURIComponent(msgMatch[1]!);
    if (!canAccessSession(ctx, user, sessionId)) {
      return json({ error: "forbidden" }, 403);
    }
    const messages = getMessagesBySession(ctx.db, sessionId);
    return json({ sessionId, messages });
  }

  // POST /api/chat — SSE streaming chat
  if (pathname === "/api/chat" && req.method === "POST") {
    return handleChat(req, ctx, user);
  }

  return json({ error: "not found", path: pathname }, 404);
}

function canAccessSession(ctx: RouteCtx, user: User, sessionId: string): boolean {
  if (user.role === "admin") return true;
  const owners = getSessionOwners(ctx.db, sessionId);
  if (owners.length === 0) return true; // legacy / anonymous session — allow
  return owners.includes(user.id);
}

async function handleChat(req: Request, ctx: RouteCtx, user: User): Promise<Response> {
  let body: { sessionId?: string; prompt?: string };
  try {
    body = (await req.json()) as { sessionId?: string; prompt?: string };
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const prompt = body.prompt?.trim();
  const sessionId = body.sessionId?.trim() || randomUUID();
  if (!prompt) return json({ error: "missing prompt" }, 400);

  if (!canAccessSession(ctx, user, sessionId)) {
    return json({ error: "forbidden" }, 403);
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const sink = controllerSink(controller);
      const renderer = createSseRenderer(sink);

      try {
        await runAgent({
          prompt,
          sessionId,
          userId: user.id,
          llmCfg: ctx.cfg.llm,
          embedCfg: ctx.cfg.embed,
          memoryCfg: ctx.cfg.memory,
          tools: registry,
          db: ctx.db,
          queue: ctx.queue,
          renderer,
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
    },
  });
}
