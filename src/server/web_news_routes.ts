/**
 * HTTP routes for the per-project Web News feature.
 *
 * Mounted from `routes.ts:handleApi` between kb-routes and workspace-routes.
 * Surface:
 *   - GET    /api/projects/:p/news/topics
 *   - POST   /api/projects/:p/news/topics
 *   - GET    /api/projects/:p/news/topics/:id
 *   - PATCH  /api/projects/:p/news/topics/:id
 *   - DELETE /api/projects/:p/news/topics/:id
 *   - POST   /api/projects/:p/news/topics/:id/run-now
 *   - POST   /api/projects/:p/news/topics/:id/regenerate-terms
 *   - GET    /api/projects/:p/news/items
 *   - DELETE /api/projects/:p/news/items/:id
 *
 * Every mutation logs `topic: "web_news"` through the queue.
 */

import type { Database } from "bun:sqlite";
import type { User } from "../auth/users.ts";
import type { BunnyConfig } from "../config.ts";
import type { BunnyQueue } from "../queue/bunqueue.ts";
import {
  errorMessage,
  errorStatus,
  logUnexpectedError,
  SafeError,
} from "../util/error.ts";
import { json, readJson } from "./http.ts";
import { canEditProject, canSeeProject } from "./routes.ts";
import {
  getProject,
  validateProjectName,
  type Project,
} from "../memory/projects.ts";
import { getAgent, isAgentLinkedToProject } from "../memory/agents.ts";
import { recordVersion } from "../memory/versioning.ts";
import {
  canEditTopic,
  createTopic,
  createFeedPattern,
  deleteFeedPattern,
  deleteNewsItem,
  deleteTopic,
  getNewsItem,
  getTopic,
  listFeedPatterns,
  listItemsForProject,
  listTopics,
  updateTopic,
  type NewsTopic,
  type TopicType,
} from "../memory/web_news.ts";
import { discoverFeeds } from "../web_news/feed_discovery.ts";
import {
  setReaction,
  removeReaction,
  listUserReactionsForProject,
  type Reaction,
} from "../memory/news_reactions.ts";
import { computeNextRun } from "../scheduler/cron.ts";
import { registry as toolsRegistry } from "../tools/index.ts";
import { runTopic } from "../web_news/run_topic.ts";
import { NEWS_AGENT_NAME, RSS_NEWS_AGENT_NAME } from "../memory/agents_seed.ts";

export interface WebNewsRouteCtx {
  db: Database;
  queue: BunnyQueue;
  cfg: BunnyConfig;
}

export async function handleWebNewsRoute(
  req: Request,
  url: URL,
  ctx: WebNewsRouteCtx,
  user: User,
): Promise<Response | null> {
  const { pathname } = url;

  // ── Global feed-patterns (not project-scoped) ─────────────────────────────
  if (pathname === "/api/news/feed-patterns") {
    if (req.method === "GET") return handleListFeedPatterns(ctx);
    if (req.method === "POST") return handleCreateFeedPattern(req, ctx, user);
  }
  const feedPatternIdMatch = pathname.match(
    /^\/api\/news\/feed-patterns\/(\d+)$/,
  );
  if (feedPatternIdMatch) {
    const id = Number(feedPatternIdMatch[1]);
    if (req.method === "DELETE") return handleDeleteFeedPattern(ctx, user, id);
  }

  // ── Per-project discover-feed ─────────────────────────────────────────────
  const discoverMatch = pathname.match(
    /^\/api\/projects\/([^/]+)\/news\/discover-feed$/,
  );
  if (discoverMatch) {
    const project = decodeURIComponent(discoverMatch[1]!);
    if (req.method === "POST")
      return handleDiscoverFeed(req, ctx, user, project);
  }

  const topicsMatch = pathname.match(
    /^\/api\/projects\/([^/]+)\/news\/topics$/,
  );
  if (topicsMatch) {
    const project = decodeURIComponent(topicsMatch[1]!);
    if (req.method === "GET") return handleList(ctx, user, project);
    if (req.method === "POST") return handleCreate(req, ctx, user, project);
  }

  const runNowMatch = pathname.match(
    /^\/api\/projects\/([^/]+)\/news\/topics\/(\d+)\/run-now$/,
  );
  if (runNowMatch) {
    const project = decodeURIComponent(runNowMatch[1]!);
    const id = Number(runNowMatch[2]);
    if (req.method === "POST") return handleRunNow(ctx, user, project, id);
  }

  const regenMatch = pathname.match(
    /^\/api\/projects\/([^/]+)\/news\/topics\/(\d+)\/regenerate-terms$/,
  );
  if (regenMatch) {
    const project = decodeURIComponent(regenMatch[1]!);
    const id = Number(regenMatch[2]);
    if (req.method === "POST")
      return handleRegenerateTerms(ctx, user, project, id);
  }

  const topicIdMatch = pathname.match(
    /^\/api\/projects\/([^/]+)\/news\/topics\/(\d+)$/,
  );
  if (topicIdMatch) {
    const project = decodeURIComponent(topicIdMatch[1]!);
    const id = Number(topicIdMatch[2]);
    if (req.method === "GET") return handleGet(ctx, user, project, id);
    if (req.method === "PATCH") return handlePatch(req, ctx, user, project, id);
    if (req.method === "DELETE") return handleDelete(ctx, user, project, id);
  }

  const itemsMatch = pathname.match(/^\/api\/projects\/([^/]+)\/news\/items$/);
  if (itemsMatch) {
    const project = decodeURIComponent(itemsMatch[1]!);
    if (req.method === "GET") return handleListItems(ctx, user, project, url);
  }

  const reactionsMatch = pathname.match(
    /^\/api\/projects\/([^/]+)\/news\/reactions$/,
  );
  if (reactionsMatch) {
    const project = decodeURIComponent(reactionsMatch[1]!);
    if (req.method === "GET") return handleListReactions(ctx, user, project);
  }

  const itemIdMatch = pathname.match(
    /^\/api\/projects\/([^/]+)\/news\/items\/(\d+)$/,
  );
  if (itemIdMatch) {
    const project = decodeURIComponent(itemIdMatch[1]!);
    const id = Number(itemIdMatch[2]);
    if (req.method === "DELETE")
      return handleDeleteItem(ctx, user, project, id);
  }

  const reactMatch = pathname.match(
    /^\/api\/projects\/([^/]+)\/news\/items\/(\d+)\/react$/,
  );
  if (reactMatch) {
    const project = decodeURIComponent(reactMatch[1]!);
    const id = Number(reactMatch[2]);
    if (req.method === "POST")
      return handleSetReaction(req, ctx, user, project, id);
    if (req.method === "DELETE")
      return handleRemoveReaction(ctx, user, project, id);
  }

  return null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

type ResolveOk = { ok: true; project: string; p: Project };
type ResolveErr = { ok: false; error: Response };
type ResolveResult = ResolveOk | ResolveErr;

function resolveProject(
  ctx: WebNewsRouteCtx,
  user: User,
  rawProject: string,
): ResolveResult {
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

function loadTopicFor(
  ctx: WebNewsRouteCtx,
  user: User,
  rawProject: string,
  id: number,
  requireEdit: boolean,
):
  | { ok: true; project: string; p: Project; topic: NewsTopic }
  | { ok: false; error: Response } {
  const r = resolveProject(ctx, user, rawProject);
  if (!r.ok) return r;
  const topic = getTopic(ctx.db, id);
  if (!topic || topic.project !== r.project) {
    return { ok: false, error: json({ error: "not found" }, 404) };
  }
  if (requireEdit && !canEditTopic(user, topic, r.p)) {
    return { ok: false, error: json({ error: "forbidden" }, 403) };
  }
  return { ok: true, project: r.project, p: r.p, topic };
}

function validateCron(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed)
    throw new SafeError("cron expression is required", { httpStatus: 400 });
  computeNextRun(trimmed, Date.now()); // throws on malformed
  return trimmed;
}

function validateAgent(
  ctx: WebNewsRouteCtx,
  project: string,
  agentName: string,
): void {
  const agent = getAgent(ctx.db, agentName);
  if (!agent)
    throw new SafeError(`agent '${agentName}' does not exist`, {
      httpStatus: 400,
    });
  if (!isAgentLinkedToProject(ctx.db, project, agentName)) {
    throw new SafeError(
      `agent '${agentName}' is not available in project '${project}'`,
      { httpStatus: 400 },
    );
  }
}

// ── List / create ────────────────────────────────────────────────────────────

function handleList(
  ctx: WebNewsRouteCtx,
  user: User,
  rawProject: string,
): Response {
  const r = resolveProject(ctx, user, rawProject);
  if (!r.ok) return r.error;
  return json({ topics: listTopics(ctx.db, r.project) });
}

interface TopicBody {
  name?: string;
  description?: string;
  agent?: string;
  terms?: string[];
  updateCron?: string;
  renewTermsCron?: string | null;
  alwaysRegenerateTerms?: boolean;
  maxItemsPerRun?: number;
  enabled?: boolean;
  topicType?: TopicType;
  feedUrl?: string | null;
  siteUrl?: string | null;
}

async function handleCreate(
  req: Request,
  ctx: WebNewsRouteCtx,
  user: User,
  rawProject: string,
): Promise<Response> {
  const r = resolveProject(ctx, user, rawProject);
  if (!r.ok) return r.error;

  const body = await readJson<TopicBody>(req);
  if (!body?.name?.trim()) return json({ error: "missing name" }, 400);
  if (!body.updateCron?.trim())
    return json({ error: "missing updateCron" }, 400);

  // Choose the right built-in agent when none is specified.
  // rss_feed → rss-news (summarisation); site_monitor → news (page analysis).
  const defaultAgent =
    body.topicType === "rss_feed" ? RSS_NEWS_AGENT_NAME : NEWS_AGENT_NAME;
  const resolvedAgent = body.agent?.trim() || defaultAgent;

  try {
    const updateCron = validateCron(body.updateCron);
    const renewCron =
      body.renewTermsCron && body.renewTermsCron.trim()
        ? validateCron(body.renewTermsCron)
        : null;
    validateAgent(ctx, r.project, resolvedAgent);
    const now = Date.now();

    const topic = createTopic(ctx.db, {
      project: r.project,
      name: body.name,
      description: body.description,
      agent: resolvedAgent,
      terms: body.terms,
      updateCron,
      renewTermsCron: renewCron,
      alwaysRegenerateTerms: body.alwaysRegenerateTerms,
      maxItemsPerRun: body.maxItemsPerRun,
      enabled: body.enabled,
      nextUpdateAt: computeNextRun(updateCron, now),
      nextRenewTermsAt: renewCron ? computeNextRun(renewCron, now) : null,
      createdBy: user.id,
      topicType: body.topicType,
      feedUrl: body.feedUrl,
      siteUrl: body.siteUrl,
    });
    recordVersion(ctx.db, "web_news_topic", topic.id, "save", user.id);

    void ctx.queue.log({
      topic: "web_news",
      kind: "topic.create",
      userId: user.id,
      data: { id: topic.id, project: r.project, name: topic.name },
    });
    return json({ topic }, 201);
  } catch (e) {
    logUnexpectedError(ctx.queue, e, "POST /api/projects/:p/news/topics");
    return json({ error: errorMessage(e) }, errorStatus(e, 400));
  }
}

function handleGet(
  ctx: WebNewsRouteCtx,
  user: User,
  rawProject: string,
  id: number,
): Response {
  const r = loadTopicFor(ctx, user, rawProject, id, false);
  if (!r.ok) return r.error;
  return json({ topic: r.topic });
}

async function handlePatch(
  req: Request,
  ctx: WebNewsRouteCtx,
  user: User,
  rawProject: string,
  id: number,
): Promise<Response> {
  const r = loadTopicFor(ctx, user, rawProject, id, true);
  if (!r.ok) return r.error;

  const body = await readJson<TopicBody>(req);
  if (!body) return json({ error: "invalid json" }, 400);

  try {
    const patch: Parameters<typeof updateTopic>[2] = {};
    const now = Date.now();
    if (body.name !== undefined) patch.name = body.name;
    if (body.description !== undefined) patch.description = body.description;
    if (body.agent !== undefined) {
      const resolvedPatchAgent = body.agent?.trim() || NEWS_AGENT_NAME;
      validateAgent(ctx, r.project, resolvedPatchAgent);
      patch.agent = resolvedPatchAgent;
    }
    if (body.terms !== undefined) patch.terms = body.terms;
    if (body.updateCron !== undefined) {
      const cron = validateCron(body.updateCron);
      patch.updateCron = cron;
      patch.nextUpdateAt = computeNextRun(cron, now);
    }
    if (body.renewTermsCron !== undefined) {
      if (body.renewTermsCron && body.renewTermsCron.trim()) {
        const cron = validateCron(body.renewTermsCron);
        patch.renewTermsCron = cron;
        patch.nextRenewTermsAt = computeNextRun(cron, now);
      } else {
        patch.renewTermsCron = null;
        patch.nextRenewTermsAt = null;
      }
    }
    if (body.alwaysRegenerateTerms !== undefined)
      patch.alwaysRegenerateTerms = body.alwaysRegenerateTerms;
    if (body.maxItemsPerRun !== undefined)
      patch.maxItemsPerRun = body.maxItemsPerRun;
    if (body.enabled !== undefined) patch.enabled = body.enabled;
    if (body.feedUrl !== undefined) patch.feedUrl = body.feedUrl;
    if (body.siteUrl !== undefined) patch.siteUrl = body.siteUrl;

    const updated = updateTopic(ctx.db, id, patch);
    recordVersion(ctx.db, "web_news_topic", id, "save", user.id);
    void ctx.queue.log({
      topic: "web_news",
      kind: "topic.update",
      userId: user.id,
      data: { id, project: r.project, changed: Object.keys(body) },
    });
    return json({ topic: updated });
  } catch (e) {
    logUnexpectedError(ctx.queue, e, "PATCH /api/news/topics/:id");
    return json({ error: errorMessage(e) }, errorStatus(e, 400));
  }
}

function handleDelete(
  ctx: WebNewsRouteCtx,
  user: User,
  rawProject: string,
  id: number,
): Response {
  const r = loadTopicFor(ctx, user, rawProject, id, true);
  if (!r.ok) return r.error;
  deleteTopic(ctx.db, id);
  void ctx.queue.log({
    topic: "web_news",
    kind: "topic.delete",
    userId: user.id,
    data: { id, project: r.project, name: r.topic.name },
  });
  return json({ ok: true });
}

// ── Run now / regenerate terms ───────────────────────────────────────────────

async function handleRunNow(
  ctx: WebNewsRouteCtx,
  user: User,
  rawProject: string,
  id: number,
): Promise<Response> {
  const r = loadTopicFor(ctx, user, rawProject, id, true);
  if (!r.ok) return r.error;

  void ctx.queue.log({
    topic: "web_news",
    kind: "topic.run_now",
    userId: user.id,
    data: { id, project: r.project },
  });

  // Detach: kick off asynchronously and return 202 immediately.
  void runTopic({
    db: ctx.db,
    queue: ctx.queue,
    cfg: ctx.cfg,
    tools: toolsRegistry,
    topicId: id,
    triggeredBy: user.id,
    triggerKind: "manual",
  }).catch(() => {
    /* errors are already captured via queue.log inside runTopic */
  });
  return json({ ok: true, accepted: true }, 202);
}

function handleRegenerateTerms(
  ctx: WebNewsRouteCtx,
  user: User,
  rawProject: string,
  id: number,
): Response {
  const r = loadTopicFor(ctx, user, rawProject, id, true);
  if (!r.ok) return r.error;

  // Force the next run into renew-mode by zeroing next_renew_terms_at.
  updateTopic(ctx.db, id, { nextRenewTermsAt: 0 });
  void ctx.queue.log({
    topic: "web_news",
    kind: "topic.regenerate_terms",
    userId: user.id,
    data: { id, project: r.project },
  });
  return json({ ok: true });
}

// ── Items ────────────────────────────────────────────────────────────────────

function handleListItems(
  ctx: WebNewsRouteCtx,
  user: User,
  rawProject: string,
  url: URL,
): Response {
  const r = resolveProject(ctx, user, rawProject);
  if (!r.ok) return r.error;

  const topicIdRaw = url.searchParams.get("topicId");
  const limitRaw = url.searchParams.get("limit");
  const sinceRaw = url.searchParams.get("since");

  const topicId = topicIdRaw ? Number(topicIdRaw) : undefined;
  if (topicId !== undefined && !Number.isFinite(topicId)) {
    return json({ error: "invalid topicId" }, 400);
  }

  const items = listItemsForProject(ctx.db, r.project, {
    topicId,
    limit: limitRaw ? Number(limitRaw) : undefined,
    since: sinceRaw ? Number(sinceRaw) : undefined,
  });
  return json({ items });
}

function handleDeleteItem(
  ctx: WebNewsRouteCtx,
  user: User,
  rawProject: string,
  id: number,
): Response {
  const r = resolveProject(ctx, user, rawProject);
  if (!r.ok) return r.error;
  if (!canEditProject(r.p, user)) return json({ error: "forbidden" }, 403);

  const item = getNewsItem(ctx.db, id);
  if (!item || item.project !== r.project)
    return json({ error: "not found" }, 404);

  deleteNewsItem(ctx.db, id);
  void ctx.queue.log({
    topic: "web_news",
    kind: "item.delete",
    userId: user.id,
    data: { id, project: r.project, topicId: item.topicId },
  });
  return json({ ok: true });
}

// ── Discover feed ─────────────────────────────────────────────────────────────

async function handleDiscoverFeed(
  req: Request,
  ctx: WebNewsRouteCtx,
  user: User,
  rawProject: string,
): Promise<Response> {
  const r = resolveProject(ctx, user, rawProject);
  if (!r.ok) return r.error;

  const body = await readJson<{ url?: string }>(req);
  const rawUrl = body?.url?.trim();
  if (!rawUrl) return json({ error: "missing url" }, 400);
  if (!/^https?:\/\//i.test(rawUrl))
    return json({ error: "url must start with http:// or https://" }, 400);

  try {
    const feeds = await discoverFeeds(rawUrl, {
      db: ctx.db,
      llmCfg: ctx.cfg.llm,
    });
    void ctx.queue.log({
      topic: "web_news",
      kind: "discover_feed",
      userId: user.id,
      data: { project: r.project, url: rawUrl, found: feeds.length },
    });
    return json({ feeds });
  } catch (e) {
    return json({ error: errorMessage(e) }, 500);
  }
}

// ── Feed patterns (global, not project-scoped) ────────────────────────────────

function handleListFeedPatterns(ctx: WebNewsRouteCtx): Response {
  return json({ patterns: listFeedPatterns(ctx.db) });
}

async function handleCreateFeedPattern(
  req: Request,
  ctx: WebNewsRouteCtx,
  user: User,
): Promise<Response> {
  if (user.role !== "admin") return json({ error: "forbidden" }, 403);
  const body = await readJson<{
    site?: string;
    name?: string;
    pattern?: string;
    variables?: unknown;
  }>(req);
  if (!body?.site?.trim()) return json({ error: "missing site" }, 400);
  if (!body?.name?.trim()) return json({ error: "missing name" }, 400);
  if (!body?.pattern?.trim()) return json({ error: "missing pattern" }, 400);

  try {
    const variables = Array.isArray(body.variables) ? body.variables : [];
    const pattern = createFeedPattern(ctx.db, {
      site: body.site,
      name: body.name,
      pattern: body.pattern,
      variables,
    });
    void ctx.queue.log({
      topic: "web_news",
      kind: "feed_pattern.create",
      userId: user.id,
      data: { id: pattern.id, site: pattern.site, name: pattern.name },
    });
    return json({ pattern }, 201);
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

// ── Reactions ─────────────────────────────────────────────────────────────────

function handleListReactions(
  ctx: WebNewsRouteCtx,
  user: User,
  rawProject: string,
): Response {
  const r = resolveProject(ctx, user, rawProject);
  if (!r.ok) return r.error;
  const map = listUserReactionsForProject(ctx.db, user.id, r.project);
  return json({ reactions: Object.fromEntries(map) });
}

async function handleSetReaction(
  req: Request,
  ctx: WebNewsRouteCtx,
  user: User,
  rawProject: string,
  id: number,
): Promise<Response> {
  const r = resolveProject(ctx, user, rawProject);
  if (!r.ok) return r.error;
  const item = getNewsItem(ctx.db, id);
  if (!item || item.project !== r.project)
    return json({ error: "not found" }, 404);
  const body = await readJson<{ reaction?: string }>(req);
  if (body?.reaction !== "up" && body?.reaction !== "down")
    return json({ error: "reaction must be 'up' or 'down'" }, 400);
  setReaction(ctx.db, user.id, id, body.reaction as Reaction);
  void ctx.queue.log({
    topic: "web_news",
    kind: "item.react",
    userId: user.id,
    data: { itemId: id, project: r.project, reaction: body.reaction },
  });
  return json({ ok: true });
}

function handleRemoveReaction(
  ctx: WebNewsRouteCtx,
  user: User,
  rawProject: string,
  id: number,
): Response {
  const r = resolveProject(ctx, user, rawProject);
  if (!r.ok) return r.error;
  removeReaction(ctx.db, user.id, id);
  void ctx.queue.log({
    topic: "web_news",
    kind: "item.react.remove",
    userId: user.id,
    data: { itemId: id, project: r.project },
  });
  return json({ ok: true });
}

function handleDeleteFeedPattern(
  ctx: WebNewsRouteCtx,
  user: User,
  id: number,
): Response {
  if (user.role !== "admin") return json({ error: "forbidden" }, 403);
  try {
    deleteFeedPattern(ctx.db, id);
    void ctx.queue.log({
      topic: "web_news",
      kind: "feed_pattern.delete",
      userId: user.id,
      data: { id },
    });
    return json({ ok: true });
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}
