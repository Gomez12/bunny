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
import { listSessions } from "../memory/sessions.ts";
import { runAgent } from "../agent/loop.ts";
import { createSseRenderer, controllerSink, finishSse } from "../agent/render_sse.ts";
import { registry } from "../tools/index.ts";
import { errorMessage } from "../util/error.ts";

export interface RouteCtx {
  db: Database;
  queue: BunnyQueue;
  cfg: BunnyConfig;
}

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

function json(body: unknown, init: number | ResponseInit = 200): Response {
  const responseInit: ResponseInit = typeof init === "number" ? { status: init } : init;
  return new Response(JSON.stringify(body), {
    ...responseInit,
    headers: { ...JSON_HEADERS, ...(responseInit.headers ?? {}) },
  });
}

export async function handleApi(req: Request, url: URL, ctx: RouteCtx): Promise<Response> {
  const { pathname } = url;

  // GET /api/sessions?q=...
  if (pathname === "/api/sessions" && req.method === "GET") {
    const q = url.searchParams.get("q") ?? undefined;
    const sessions = listSessions(ctx.db, { search: q });
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
    const messages = getMessagesBySession(ctx.db, sessionId);
    return json({ sessionId, messages });
  }

  // POST /api/chat — SSE streaming chat
  if (pathname === "/api/chat" && req.method === "POST") {
    return handleChat(req, ctx);
  }

  return json({ error: "not found", path: pathname }, 404);
}

async function handleChat(req: Request, ctx: RouteCtx): Promise<Response> {
  let body: { sessionId?: string; prompt?: string };
  try {
    body = (await req.json()) as { sessionId?: string; prompt?: string };
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const prompt = body.prompt?.trim();
  const sessionId = body.sessionId?.trim() || randomUUID();
  if (!prompt) return json({ error: "missing prompt" }, 400);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const sink = controllerSink(controller);
      const renderer = createSseRenderer(sink);

      try {
        await runAgent({
          prompt,
          sessionId,
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
