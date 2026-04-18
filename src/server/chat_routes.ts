/**
 * Chat-domain HTTP routes: quick-chat toggle, fork, message edit/trim/regenerate.
 */

import type { Database } from "bun:sqlite";
import type { BunnyConfig } from "../config.ts";
import type { BunnyQueue } from "../queue/bunqueue.ts";

import {
  canEditMessage,
  editMessageContent,
  findPriorUserMessage,
  getMessageOwner,
  trimSessionAfter,
} from "../memory/messages.ts";
import { forkSession } from "../memory/sessions.ts";
import { setSessionQuickChat } from "../memory/session_visibility.ts";
import { getSessionProject } from "../memory/projects.ts";
import { runAgent } from "../agent/loop.ts";
import {
  controllerSink,
  createSseRenderer,
  finishSse,
} from "../agent/render_sse.ts";
import { registry } from "../tools/index.ts";
import { errorMessage } from "../util/error.ts";
import { json } from "./http.ts";
import type { User } from "../auth/users.ts";

export interface ChatRouteCtx {
  db: Database;
  queue: BunnyQueue;
  cfg: BunnyConfig;
  /** Caller-provided session ACL — same predicate used by routes.ts:canAccessSession. */
  canAccessSession: (sessionId: string) => boolean;
}

export async function handleChatRoute(
  req: Request,
  url: URL,
  ctx: ChatRouteCtx,
  user: User,
): Promise<Response | null> {
  const { pathname } = url;

  // ── PATCH /api/sessions/:id/quick-chat ──────────────────────────────────
  const qcMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/quick-chat$/);
  if (qcMatch && req.method === "PATCH") {
    const sessionId = decodeURIComponent(qcMatch[1]!);
    if (!ctx.canAccessSession(sessionId))
      return json({ error: "forbidden" }, 403);
    let body: { isQuickChat?: boolean };
    try {
      body = (await req.json()) as { isQuickChat?: boolean };
    } catch {
      return json({ error: "invalid json" }, 400);
    }
    if (typeof body.isQuickChat !== "boolean")
      return json({ error: "isQuickChat (boolean) is required" }, 400);
    setSessionQuickChat(ctx.db, user.id, sessionId, body.isQuickChat);
    void ctx.queue.log({
      topic: "session",
      kind: "quick_chat.toggle",
      userId: user.id,
      data: { sessionId, isQuickChat: body.isQuickChat },
    });
    return json({ ok: true, sessionId, isQuickChat: body.isQuickChat });
  }

  const forkMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/fork$/);
  if (forkMatch && req.method === "POST") {
    const srcSessionId = decodeURIComponent(forkMatch[1]!);
    if (!ctx.canAccessSession(srcSessionId))
      return json({ error: "forbidden" }, 403);
    let body: {
      untilMessageId?: number | null;
      asQuickChat?: boolean;
      project?: string;
      editLastMessageContent?: string;
    };
    try {
      body = (await req.json().catch(() => ({}))) as typeof body;
    } catch {
      return json({ error: "invalid json" }, 400);
    }
    try {
      const asQuickChat = body.asQuickChat ?? true;
      const result = forkSession(ctx.db, srcSessionId, {
        userId: user.id,
        project: body.project,
        untilMessageId: body.untilMessageId ?? null,
        asQuickChat,
        editLastMessageContent: body.editLastMessageContent,
      });
      void ctx.queue.log({
        topic: "session",
        kind: "fork",
        userId: user.id,
        data: {
          src: srcSessionId,
          dst: result.sessionId,
          untilMessageId: body.untilMessageId ?? null,
          asQuickChat,
          copiedCount: result.copiedCount,
        },
      });
      return json(
        {
          sessionId: result.sessionId,
          project: result.project,
          copiedCount: result.copiedCount,
        },
        201,
      );
    } catch (e) {
      return json({ error: errorMessage(e) }, 400);
    }
  }

  const editMatch = pathname.match(/^\/api\/messages\/(\d+)$/);
  if (editMatch && req.method === "PATCH") {
    const messageId = Number(editMatch[1]);
    const owner = getMessageOwner(ctx.db, messageId);
    if (!owner) return json({ error: "not found" }, 404);
    if (!canEditMessage(owner.userId, user))
      return json({ error: "forbidden" }, 403);
    let body: { content?: string };
    try {
      body = (await req.json()) as { content?: string };
    } catch {
      return json({ error: "invalid json" }, 400);
    }
    if (typeof body.content !== "string")
      return json({ error: "content (string) is required" }, 400);
    editMessageContent(ctx.db, messageId, body.content);
    void ctx.queue.log({
      topic: "message",
      kind: "edit",
      userId: user.id,
      sessionId: owner.sessionId,
      data: { messageId, length: body.content.length },
    });
    return json({ ok: true, messageId });
  }

  const trimMatch = pathname.match(/^\/api\/messages\/(\d+)\/trim-after$/);
  if (trimMatch && req.method === "POST") {
    const messageId = Number(trimMatch[1]);
    const owner = getMessageOwner(ctx.db, messageId);
    if (!owner) return json({ error: "not found" }, 404);
    if (!canEditMessage(owner.userId, user))
      return json({ error: "forbidden" }, 403);
    const result = trimSessionAfter(ctx.db, owner.sessionId, messageId);
    void ctx.queue.log({
      topic: "message",
      kind: "trim",
      userId: user.id,
      sessionId: owner.sessionId,
      data: { fromMessageId: messageId, count: result.trimmedCount },
    });
    return json({ ok: true, ...result });
  }

  const regenMatch = pathname.match(/^\/api\/messages\/(\d+)\/regenerate$/);
  if (regenMatch && req.method === "POST") {
    const messageId = Number(regenMatch[1]);
    return handleRegenerate(req, ctx, user, messageId);
  }

  return null;
}

async function handleRegenerate(
  req: Request,
  ctx: ChatRouteCtx,
  user: User,
  messageId: number,
): Promise<Response> {
  const target = ctx.db
    .prepare(
      `SELECT id, session_id, ts, role, content, user_id
         FROM messages WHERE id = ? AND trimmed_at IS NULL`,
    )
    .get(messageId) as
    | {
        id: number;
        session_id: string;
        ts: number;
        role: string;
        content: string | null;
        user_id: string | null;
      }
    | undefined;
  if (!target) return json({ error: "not found" }, 404);
  if (target.role !== "assistant" && target.role !== "user")
    return json(
      { error: "regenerate only applies to user or assistant messages" },
      400,
    );
  if (!canEditMessage(target.user_id, user))
    return json({ error: "forbidden" }, 403);

  // Assistant target → re-answer the prior user prompt and chain as alt
  // version. User target → re-answer this prompt in place (save+regenerate
  // has already trimmed the old answer below it; no chain pointer).
  let prompt: string;
  let regenOfMessageId: number | undefined;
  let priorUserMessageId: number | null = null;
  if (target.role === "assistant") {
    const prior = findPriorUserMessage(ctx.db, target.session_id, target.id);
    if (!prior)
      return json(
        { error: "no prior user message found in this session" },
        400,
      );
    prompt = prior.content;
    priorUserMessageId = prior.id;
    regenOfMessageId = messageId;
  } else {
    prompt = (target.content ?? "").trim();
    if (!prompt) return json({ error: "user message has no content" }, 400);
  }

  const project = getSessionProject(ctx.db, target.session_id) ?? "general";

  await req.text().catch(() => "");

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const sink = controllerSink(controller);
      const renderer = createSseRenderer(sink);
      try {
        await runAgent({
          prompt,
          sessionId: target.session_id,
          userId: user.id,
          project,
          llmCfg: ctx.cfg.llm,
          embedCfg: ctx.cfg.embed,
          memoryCfg: ctx.cfg.memory,
          agentCfg: ctx.cfg.agent,
          webCfg: ctx.cfg.web,
          tools: registry,
          db: ctx.db,
          queue: ctx.queue,
          renderer,
          skipUserInsert: true,
          regenOfMessageId,
        });
        void ctx.queue.log({
          topic: "message",
          kind: "regenerate",
          userId: user.id,
          sessionId: target.session_id,
          data: {
            targetRole: target.role,
            regenOfMessageId: regenOfMessageId ?? null,
            priorUserMessageId,
          },
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
      "X-Session-Id": target.session_id,
      "X-Project": project,
      ...(regenOfMessageId ? { "X-Regen-Of": String(regenOfMessageId) } : {}),
    },
  });
}
