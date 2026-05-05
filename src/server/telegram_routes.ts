/**
 * HTTP routes for the per-project Telegram integration.
 *
 * Two layers:
 *   - Public: `POST /api/telegram/webhook/:project` — Telegram posts updates
 *     here. Authenticated via the `X-Telegram-Bot-Api-Secret-Token` header,
 *     compared constant-time against the stored secret. MUST be mounted
 *     before the auth middleware in `routes.ts:handleApi` so Telegram servers
 *     can reach it without a Bunny session.
 *   - Authenticated: `/api/projects/:p/telegram*`, `/api/me/telegram-links*`,
 *     `/api/projects/:p/news/topics/:id/subscribers`. Admin or
 *     project-creator only for project-level surfaces; user-scoped for link
 *     generation and news-subscriber toggles.
 *
 * See ADR 0028.
 */

import { timingSafeEqual } from "node:crypto";

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
import type { Database } from "bun:sqlite";
import type { User } from "../auth/users.ts";
import type { BunnyConfig } from "../config.ts";
import type { BunnyQueue } from "../queue/bunqueue.ts";
import type { Project } from "../memory/projects.ts";
import { errorMessage } from "../util/error.ts";
import { json, readJson } from "./http.ts";
import { getProject, validateProjectName } from "../memory/projects.ts";
import { getUserById } from "../auth/users.ts";
import {
  deleteTelegramConfig,
  getTelegramConfig,
  patchTelegramConfig,
  upsertTelegramConfig,
  type TelegramConfig,
} from "../memory/telegram_config.ts";
import {
  deleteLinkByUser,
  getLinkByUser,
  listLinksForUser,
  type TelegramLink,
} from "../memory/telegram_links.ts";
import {
  addTopicSubscriber,
  listTopicSubscribers,
  removeTopicSubscriber,
  setTopicSubscribers,
} from "../memory/web_news_subscriptions.ts";
import { getTopic } from "../memory/web_news.ts";
import {
  deleteWebhook,
  getMe,
  sendMessage,
  TelegramApiError,
} from "../telegram/client.ts";
import { handleTelegramUpdate } from "../telegram/handle_update.ts";
import { startPendingLink } from "../telegram/linking.ts";
import { tokenTail } from "../telegram/util.ts";
import { applyTransport } from "../telegram/webhook_setup.ts";
import { registry as toolsRegistry } from "../tools/index.ts";
import { canSeeProject } from "./routes.ts";

export interface TelegramRouteCtx {
  db: Database;
  queue: BunnyQueue;
  cfg: BunnyConfig;
}

/* ─────────────────────────────────────────────────────────────────────────── */
/*  Public — webhook endpoint                                                 */
/* ─────────────────────────────────────────────────────────────────────────── */

/**
 * Route handler for paths that MUST be reachable without auth. Today that's
 * only `POST /api/telegram/webhook/:project`. Returns null when the path
 * isn't owned by this module.
 */
export async function handleTelegramPublicRoute(
  req: Request,
  url: URL,
  ctx: TelegramRouteCtx,
): Promise<Response | null> {
  const match = url.pathname.match(/^\/api\/telegram\/webhook\/([^/]+)$/);
  if (!match) return null;
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const project = decodeURIComponent(match[1]!);
  const tgCfg = getTelegramConfig(ctx.db, project);
  // Always 200 on the webhook endpoint so Telegram doesn't retry a deliberate
  // reject. We log the reason via the queue so admins can see it in Logs.
  if (!tgCfg || !tgCfg.enabled || tgCfg.transport !== "webhook") {
    void ctx.queue.log({
      topic: "telegram",
      kind: "webhook.receive.ignored",
      data: { project, reason: !tgCfg ? "no_config" : "wrong_transport" },
    });
    return json({ ok: true });
  }

  const headerSecret = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (
    !tgCfg.webhookSecret ||
    !constantTimeEq(headerSecret, tgCfg.webhookSecret)
  ) {
    void ctx.queue.log({
      topic: "telegram",
      kind: "webhook.receive.rejected",
      data: { project, reason: "bad_secret" },
    });
    // 401 so Telegram stops retrying from a misconfigured other bot.
    return json({ error: "unauthorized" }, 401);
  }

  const update = await readJson<unknown>(req);
  if (!update || typeof update !== "object") {
    return json({ ok: true });
  }
  void ctx.queue.log({
    topic: "telegram",
    kind: "webhook.receive",
    data: {
      project,
      updateId: (update as { update_id?: number }).update_id,
    },
  });
  // Always return 200 immediately, but kick dispatch off async so the HTTP
  // handshake with Telegram stays quick.
  void handleTelegramUpdate({
    db: ctx.db,
    queue: ctx.queue,
    cfg: ctx.cfg,
    tools: toolsRegistry,
    project,
    update: update as Parameters<typeof handleTelegramUpdate>[0]["update"],
  }).catch((err) => {
    void ctx.queue.log({
      topic: "telegram",
      kind: "error",
      data: { stage: "webhook.dispatch", project },
      error: errorMessage(err),
    });
  });
  return json({ ok: true });
}

/* ─────────────────────────────────────────────────────────────────────────── */
/*  Authenticated                                                             */
/* ─────────────────────────────────────────────────────────────────────────── */

export async function handleTelegramRoute(
  req: Request,
  url: URL,
  ctx: TelegramRouteCtx,
  user: User,
): Promise<Response | null> {
  const { pathname } = url;

  // Per-user links
  if (pathname === "/api/me/telegram-links" && req.method === "GET") {
    return handleListMyLinks(ctx, user);
  }
  if (pathname === "/api/me/telegram-links" && req.method === "POST") {
    return handleCreatePendingLink(req, ctx, user);
  }
  const unlinkMatch = pathname.match(/^\/api\/me\/telegram-links\/([^/]+)$/);
  if (unlinkMatch && req.method === "DELETE") {
    const project = decodeURIComponent(unlinkMatch[1]!);
    return handleUnlink(ctx, user, project);
  }

  // Per-project config
  const configMatch = pathname.match(/^\/api\/projects\/([^/]+)\/telegram$/);
  if (configMatch) {
    const rawProject = decodeURIComponent(configMatch[1]!);
    if (req.method === "GET") return handleGetConfig(ctx, user, rawProject);
    if (req.method === "PUT")
      return handlePutConfig(req, ctx, user, rawProject);
    if (req.method === "DELETE")
      return handleDeleteConfig(ctx, user, rawProject);
  }
  const regenMatch = pathname.match(
    /^\/api\/projects\/([^/]+)\/telegram\/regenerate-webhook-secret$/,
  );
  if (regenMatch && req.method === "POST") {
    const rawProject = decodeURIComponent(regenMatch[1]!);
    return handleRegenerateSecret(ctx, user, rawProject);
  }
  const testSendMatch = pathname.match(
    /^\/api\/projects\/([^/]+)\/telegram\/test-send$/,
  );
  if (testSendMatch && req.method === "POST") {
    const rawProject = decodeURIComponent(testSendMatch[1]!);
    return handleTestSend(req, ctx, user, rawProject);
  }

  // Web News subscriber toggles
  const subsMatch = pathname.match(
    /^\/api\/projects\/([^/]+)\/news\/topics\/(\d+)\/subscribers$/,
  );
  if (subsMatch) {
    const rawProject = decodeURIComponent(subsMatch[1]!);
    const topicId = Number(subsMatch[2]);
    if (req.method === "GET")
      return handleListSubs(ctx, user, rawProject, topicId);
    if (req.method === "PUT")
      return handlePutSubs(req, ctx, user, rawProject, topicId);
  }
  const subsItemMatch = pathname.match(
    /^\/api\/projects\/([^/]+)\/news\/topics\/(\d+)\/subscribers\/([^/]+)$/,
  );
  if (subsItemMatch) {
    const rawProject = decodeURIComponent(subsItemMatch[1]!);
    const topicId = Number(subsItemMatch[2]);
    const userId = decodeURIComponent(subsItemMatch[3]!);
    if (req.method === "POST")
      return handleAddSub(ctx, user, rawProject, topicId, userId);
    if (req.method === "DELETE")
      return handleRemoveSub(ctx, user, rawProject, topicId, userId);
  }

  return null;
}

/* ─────────────────────────────────────────────────────────────────────────── */
/*  Helpers                                                                   */
/* ─────────────────────────────────────────────────────────────────────────── */

interface TelegramConfigDto {
  project: string;
  botTokenMasked: string;
  botUsername: string;
  transport: "poll" | "webhook";
  hasWebhookSecret: boolean;
  enabled: boolean;
  lastUpdateId: number;
  webhookUrl: string | null;
  createdAt: number;
  updatedAt: number;
}

function maskToken(token: string): string {
  if (token.length <= 4) return "…";
  return `…${tokenTail(token)}`;
}

function toConfigDto(
  cfg: TelegramConfig,
  publicBaseUrl: string,
): TelegramConfigDto {
  return {
    project: cfg.project,
    botTokenMasked: maskToken(cfg.botToken),
    botUsername: cfg.botUsername,
    transport: cfg.transport,
    hasWebhookSecret: !!cfg.webhookSecret,
    enabled: cfg.enabled,
    lastUpdateId: cfg.lastUpdateId,
    webhookUrl:
      cfg.transport === "webhook" && publicBaseUrl
        ? `${publicBaseUrl.replace(/\/+$/, "")}/api/telegram/webhook/${encodeURIComponent(cfg.project)}`
        : null,
    createdAt: cfg.createdAt,
    updatedAt: cfg.updatedAt,
  };
}

type ResolveOk = { ok: true; project: string; p: Project };
type ResolveErr = { ok: false; error: Response };

function resolveProject(
  ctx: TelegramRouteCtx,
  user: User,
  rawProject: string,
): ResolveOk | ResolveErr {
  let project: string;
  try {
    project = validateProjectName(rawProject);
  } catch (e) {
    return { ok: false, error: json({ error: errorMessage(e) }, 400) };
  }
  const p = getProject(ctx.db, project);
  if (!p)
    return { ok: false, error: json({ error: "project not found" }, 404) };
  if (!canSeeProject(p, user))
    return { ok: false, error: json({ error: "forbidden" }, 403) };
  return { ok: true, project, p };
}

/** Admin or project creator only — the bot token is an impersonation capability. */
function canAdministerTelegram(p: Project, user: User): boolean {
  if (user.role === "admin") return true;
  return p.createdBy === user.id;
}

function constantTimeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function tgErrorToResponse(err: unknown): Response {
  if (err instanceof TelegramApiError) {
    return json(
      {
        error: "telegram api error",
        code: err.code,
        description: err.description,
      },
      400,
    );
  }
  return json({ error: errorMessage(err) }, 400);
}

/* ─────────────────────────────────────────────────────────────────────────── */
/*  Config CRUD                                                               */
/* ─────────────────────────────────────────────────────────────────────────── */

function handleGetConfig(
  ctx: TelegramRouteCtx,
  user: User,
  rawProject: string,
): Response {
  const r = resolveProject(ctx, user, rawProject);
  if (!r.ok) return r.error;
  if (!canAdministerTelegram(r.p, user))
    return json({ error: "forbidden" }, 403);
  const cfg = getTelegramConfig(ctx.db, r.project);
  return json({
    config: cfg ? toConfigDto(cfg, ctx.cfg.telegram.publicBaseUrl) : null,
    publicBaseUrl: ctx.cfg.telegram.publicBaseUrl || null,
  });
}

interface PutConfigBody {
  botToken?: string;
  transport?: "poll" | "webhook";
  enabled?: boolean;
}

async function handlePutConfig(
  req: Request,
  ctx: TelegramRouteCtx,
  user: User,
  rawProject: string,
): Promise<Response> {
  const r = resolveProject(ctx, user, rawProject);
  if (!r.ok) return r.error;
  if (!canAdministerTelegram(r.p, user))
    return json({ error: "forbidden" }, 403);

  const body = await readJson<PutConfigBody>(req);
  if (!body) return json({ error: "invalid json" }, 400);

  const existing = getTelegramConfig(ctx.db, r.project);
  const nextTransport = body.transport ?? existing?.transport ?? "poll";
  const token = body.botToken?.trim() ?? existing?.botToken ?? "";
  if (!token) return json({ error: "botToken is required" }, 400);

  // Validate the token with getMe — this also populates the bot username.
  let botUsername: string;
  try {
    const me = await getMe(token);
    if (!me.is_bot) return json({ error: "token is not a bot" }, 400);
    botUsername = me.username;
  } catch (err) {
    return tgErrorToResponse(err);
  }

  // Generate a webhook secret when switching into webhook mode without one.
  let webhookSecret: string | null | undefined = undefined;
  if (nextTransport === "webhook") {
    webhookSecret = existing?.webhookSecret ?? randomHex(24);
  }

  const cfg = upsertTelegramConfig(ctx.db, {
    project: r.project,
    botToken: token,
    botUsername,
    transport: nextTransport,
    webhookSecret,
    enabled: body.enabled ?? existing?.enabled ?? true,
  });
  void ctx.queue.log({
    topic: "telegram",
    kind: existing ? "config.update" : "config.create",
    userId: user.id,
    data: {
      project: r.project,
      transport: cfg.transport,
      enabled: cfg.enabled,
      tokenTail: tokenTail(token),
      botUsername,
    },
  });

  // Apply transport — best-effort; on failure we already logged via queue.
  try {
    await applyTransport({
      db: ctx.db,
      queue: ctx.queue,
      project: r.project,
      publicBaseUrl: ctx.cfg.telegram.publicBaseUrl || undefined,
    });
  } catch (err) {
    return tgErrorToResponse(err);
  }

  const fresh = getTelegramConfig(ctx.db, r.project);
  return json({
    config: fresh ? toConfigDto(fresh, ctx.cfg.telegram.publicBaseUrl) : null,
  });
}

async function handleDeleteConfig(
  ctx: TelegramRouteCtx,
  user: User,
  rawProject: string,
): Promise<Response> {
  const r = resolveProject(ctx, user, rawProject);
  if (!r.ok) return r.error;
  if (!canAdministerTelegram(r.p, user))
    return json({ error: "forbidden" }, 403);

  const existing = getTelegramConfig(ctx.db, r.project);
  if (existing) {
    // Best-effort unregister before we delete the token.
    try {
      await deleteWebhook(existing.botToken);
    } catch {
      /* swallow — we're deleting anyway */
    }
    deleteTelegramConfig(ctx.db, r.project);
    void ctx.queue.log({
      topic: "telegram",
      kind: "config.delete",
      userId: user.id,
      data: { project: r.project },
    });
  }
  return json({ ok: true });
}

async function handleRegenerateSecret(
  ctx: TelegramRouteCtx,
  user: User,
  rawProject: string,
): Promise<Response> {
  const r = resolveProject(ctx, user, rawProject);
  if (!r.ok) return r.error;
  if (!canAdministerTelegram(r.p, user))
    return json({ error: "forbidden" }, 403);

  const cfg = getTelegramConfig(ctx.db, r.project);
  if (!cfg) return json({ error: "not found" }, 404);
  const secret = randomHex(24);
  patchTelegramConfig(ctx.db, r.project, { webhookSecret: secret });
  void ctx.queue.log({
    topic: "telegram",
    kind: "webhook.secret.rotate",
    userId: user.id,
    data: { project: r.project },
  });
  if (cfg.transport === "webhook") {
    try {
      await applyTransport({
        db: ctx.db,
        queue: ctx.queue,
        project: r.project,
        publicBaseUrl: ctx.cfg.telegram.publicBaseUrl || undefined,
      });
    } catch (err) {
      return tgErrorToResponse(err);
    }
  }
  return json({ ok: true });
}

interface TestSendBody {
  chatId?: number;
  text?: string;
}

async function handleTestSend(
  req: Request,
  ctx: TelegramRouteCtx,
  user: User,
  rawProject: string,
): Promise<Response> {
  const r = resolveProject(ctx, user, rawProject);
  if (!r.ok) return r.error;
  if (!canAdministerTelegram(r.p, user))
    return json({ error: "forbidden" }, 403);
  const body = await readJson<TestSendBody>(req);
  if (!body?.chatId || !Number.isFinite(body.chatId)) {
    return json({ error: "chatId (number) is required" }, 400);
  }
  const cfg = getTelegramConfig(ctx.db, r.project);
  if (!cfg) return json({ error: "telegram is not configured" }, 404);
  try {
    const result = await sendMessage(cfg.botToken, {
      chat_id: body.chatId,
      text: body.text?.trim() || "Test from Bunny 🐇",
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
    void ctx.queue.log({
      topic: "telegram",
      kind: "test_send",
      userId: user.id,
      data: { project: r.project, chatId: body.chatId },
    });
    return json({ ok: true, messageId: result.message_id });
  } catch (err) {
    return tgErrorToResponse(err);
  }
}

/* ─────────────────────────────────────────────────────────────────────────── */
/*  Per-user link management                                                 */
/* ─────────────────────────────────────────────────────────────────────────── */

interface LinkDto {
  project: string;
  chatIdMasked: string;
  tgUsername: string | null;
  currentSessionId: string | null;
  linkedAt: number;
}

function maskChatId(chatId: number): string {
  const s = String(chatId);
  if (s.length <= 4) return `…${s}`;
  return `…${s.slice(-4)}`;
}

function toLinkDto(link: TelegramLink): LinkDto {
  return {
    project: link.project,
    chatIdMasked: maskChatId(link.chatId),
    tgUsername: link.tgUsername,
    currentSessionId: link.currentSessionId,
    linkedAt: link.linkedAt,
  };
}

function handleListMyLinks(ctx: TelegramRouteCtx, user: User): Response {
  const links = listLinksForUser(ctx.db, user.id).map(toLinkDto);
  return json({ links });
}

interface CreateLinkBody {
  project?: string;
}

async function handleCreatePendingLink(
  req: Request,
  ctx: TelegramRouteCtx,
  user: User,
): Promise<Response> {
  const body = await readJson<CreateLinkBody>(req);
  if (!body?.project) return json({ error: "project is required" }, 400);
  const r = resolveProject(ctx, user, body.project);
  if (!r.ok) return r.error;
  try {
    const result = startPendingLink(ctx.db, {
      userId: user.id,
      project: r.project,
    });
    void ctx.queue.log({
      topic: "telegram",
      kind: "link.create.pending",
      userId: user.id,
      data: { project: r.project, botUsername: result.botUsername },
    });
    return json({
      token: result.token,
      expiresAt: result.expiresAt,
      botUsername: result.botUsername,
      deepLink: result.deepLink,
    });
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

function handleUnlink(
  ctx: TelegramRouteCtx,
  user: User,
  rawProject: string,
): Response {
  let project: string;
  try {
    project = validateProjectName(rawProject);
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
  const link = getLinkByUser(ctx.db, user.id, project);
  if (!link) return json({ error: "not found" }, 404);
  deleteLinkByUser(ctx.db, user.id, project);
  void ctx.queue.log({
    topic: "telegram",
    kind: "link.delete",
    userId: user.id,
    data: { project, chatIdMasked: maskChatId(link.chatId) },
  });
  return json({ ok: true });
}

/* ─────────────────────────────────────────────────────────────────────────── */
/*  Web News subscribers                                                     */
/* ─────────────────────────────────────────────────────────────────────────── */

function handleListSubs(
  ctx: TelegramRouteCtx,
  user: User,
  rawProject: string,
  topicId: number,
): Response {
  const r = resolveProject(ctx, user, rawProject);
  if (!r.ok) return r.error;
  const topic = getTopic(ctx.db, topicId);
  if (!topic || topic.project !== r.project)
    return json({ error: "not found" }, 404);
  const subs = listTopicSubscribers(ctx.db, topicId);
  return json({
    subscribers: subs.map((s) => ({
      userId: s.userId,
      createdAt: s.createdAt,
    })),
    creator: topic.createdBy,
  });
}

interface PutSubsBody {
  userIds?: string[];
}

async function handlePutSubs(
  req: Request,
  ctx: TelegramRouteCtx,
  user: User,
  rawProject: string,
  topicId: number,
): Promise<Response> {
  const r = resolveProject(ctx, user, rawProject);
  if (!r.ok) return r.error;
  if (!canAdministerTelegram(r.p, user) && r.p.createdBy !== user.id)
    return json({ error: "forbidden" }, 403);
  const topic = getTopic(ctx.db, topicId);
  if (!topic || topic.project !== r.project)
    return json({ error: "not found" }, 404);
  const body = await readJson<PutSubsBody>(req);
  const raw = body?.userIds ?? [];
  const valid: string[] = [];
  for (const uid of raw) {
    if (typeof uid !== "string") continue;
    const u = getUserById(ctx.db, uid);
    if (!u) continue;
    if (!valid.includes(uid)) valid.push(uid);
  }
  setTopicSubscribers(ctx.db, topicId, valid);
  void ctx.queue.log({
    topic: "telegram",
    kind: "news.subscribers.update",
    userId: user.id,
    data: { project: r.project, topicId, count: valid.length },
  });
  return json({ ok: true, count: valid.length });
}

function handleAddSub(
  ctx: TelegramRouteCtx,
  user: User,
  rawProject: string,
  topicId: number,
  subUserId: string,
): Response {
  const r = resolveProject(ctx, user, rawProject);
  if (!r.ok) return r.error;
  // Only admins, project owner, or the subscribing user themselves.
  if (
    user.id !== subUserId &&
    !canAdministerTelegram(r.p, user) &&
    r.p.createdBy !== user.id
  ) {
    return json({ error: "forbidden" }, 403);
  }
  const topic = getTopic(ctx.db, topicId);
  if (!topic || topic.project !== r.project)
    return json({ error: "not found" }, 404);
  if (!getUserById(ctx.db, subUserId))
    return json({ error: "user not found" }, 404);
  addTopicSubscriber(ctx.db, topicId, subUserId);
  void ctx.queue.log({
    topic: "telegram",
    kind: "news.subscribers.add",
    userId: user.id,
    data: { project: r.project, topicId, subUserId },
  });
  return json({ ok: true });
}

function handleRemoveSub(
  ctx: TelegramRouteCtx,
  user: User,
  rawProject: string,
  topicId: number,
  subUserId: string,
): Response {
  const r = resolveProject(ctx, user, rawProject);
  if (!r.ok) return r.error;
  if (
    user.id !== subUserId &&
    !canAdministerTelegram(r.p, user) &&
    r.p.createdBy !== user.id
  ) {
    return json({ error: "forbidden" }, 403);
  }
  const topic = getTopic(ctx.db, topicId);
  if (!topic || topic.project !== r.project)
    return json({ error: "not found" }, 404);
  removeTopicSubscriber(ctx.db, topicId, subUserId);
  void ctx.queue.log({
    topic: "telegram",
    kind: "news.subscribers.remove",
    userId: user.id,
    data: { project: r.project, topicId, subUserId },
  });
  return json({ ok: true });
}
