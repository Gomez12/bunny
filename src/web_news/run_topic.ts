/**
 * Web News — single-topic run orchestrator.
 *
 * Mirrors `src/board/run_card.ts`: the entry called by both
 * `POST /api/projects/:p/news/topics/:id/run-now` and the auto-run scan handler.
 *
 * Flow:
 *   1. `claimTopicForRun` — conditional UPDATE, 409 on lost race.
 *   2. Decide mode: renewTerms iff `terms.length === 0 || alwaysRegenerate ||
 *      now >= nextRenewTermsAt`.
 *   3. Build a user message (embedding previous items to deduplicate), open a
 *      hidden session `web-news-<uuid>`, call `runAgent` with the topic's
 *      agent + web tools via `webCfg`.
 *   4. Extract the fenced JSON block from the final answer; upsert new items;
 *      recompute `next_update_at` and, if rotated, `next_renew_terms_at`.
 *   5. Always `releaseTopic` (idle, ok/error) in `finally`.
 */

import type { Database } from "bun:sqlite";
import type { BunnyConfig } from "../config.ts";
import type { BunnyQueue } from "../queue/bunqueue.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import { runAgent } from "../agent/loop.ts";
import { silentRenderer } from "../agent/render.ts";
import { setSessionHiddenFromChat } from "../memory/session_visibility.ts";
import { errorDetails } from "../util/error.ts";
import { extractLlmJsonCandidates } from "../util/llm_json.ts";
import { computeNextRun } from "../scheduler/cron.ts";
import { resolvePrompt, interpolate } from "../prompts/resolve.ts";
import {
  claimTopicForRun,
  getTopic,
  listRecentItemsForTopic,
  releaseTopic,
  upsertNewsItem,
  type NewsTopic,
} from "../memory/web_news.ts";
import { listTopicSubscribers } from "../memory/web_news_subscriptions.ts";
import { sendTelegramToUser } from "../telegram/outbound.ts";
import { parseFeed } from "./feed_parser.ts";
import { runSiteMonitor } from "./site_monitor.ts";
import { summariseRssItems } from "./rss_summarizer.ts";

export interface RunTopicOpts {
  db: Database;
  queue: BunnyQueue;
  cfg: BunnyConfig;
  tools: ToolRegistry;
  topicId: number;
  triggeredBy: string;
  triggerKind: "manual" | "scheduled";
  /** Override the current-time clock (tests only). */
  now?: number;
}

export interface RunTopicResult {
  topicId: number;
  sessionId: string;
  inserted: number;
  duplicates: number;
  mode: "fetch" | "renew+fetch" | "rss" | "site_monitor";
  terms: string[];
  error?: string;
}

export interface ParsedNewsPayload {
  items: ParsedNewsItem[];
  improvedTerms: string[] | null;
}

export interface ParsedNewsItem {
  title: string;
  summary: string;
  url: string | null;
  imageUrl: string | null;
  source: string | null;
  publishedAt: number | null;
}

export async function runTopic(opts: RunTopicOpts): Promise<RunTopicResult> {
  const { db, queue, cfg, tools, topicId } = opts;
  const topic = getTopic(db, topicId);
  if (!topic) throw new Error(`topic ${topicId} not found`);

  if (!claimTopicForRun(db, topicId)) {
    throw new Error("topic run already in progress");
  }

  const now = opts.now ?? Date.now();

  // ── Dispatch to type-specific runner ────────────────────────────────────────
  if (topic.topicType === "rss_feed") {
    return runRssFeed(topic, {
      db,
      queue,
      cfg,
      tools,
      triggeredBy: opts.triggeredBy,
      now,
    });
  }
  if (topic.topicType === "site_monitor") {
    return runSiteMonitorTopic(topic, {
      db,
      queue,
      cfg,
      tools,
      triggeredBy: opts.triggeredBy,
      now,
    });
  }
  // ── keyword_search (existing flow) ──────────────────────────────────────────

  const needsRenewByCron =
    topic.nextRenewTermsAt !== null && topic.nextRenewTermsAt <= now;
  const renewTerms =
    topic.terms.length === 0 || topic.alwaysRegenerateTerms || needsRenewByCron;

  void queue.log({
    topic: "web_news",
    kind: "topic.run.start",
    userId: opts.triggeredBy,
    data: {
      topicId,
      project: topic.project,
      agent: topic.agent,
      mode: renewTerms ? "renew+fetch" : "fetch",
      triggerKind: opts.triggerKind,
    },
  });

  const sessionId = `web-news-${crypto.randomUUID()}`;
  setSessionHiddenFromChat(db, opts.triggeredBy, sessionId, true);

  const prompt = buildUserMessage(topic, {
    renewTerms,
    previousItems: listRecentItemsForTopic(db, topicId, 30),
    project: topic.project,
    today: new Date(now).toISOString().slice(0, 10),
  });

  const result: RunTopicResult = {
    topicId,
    sessionId,
    inserted: 0,
    duplicates: 0,
    mode: renewTerms ? "renew+fetch" : "fetch",
    terms: topic.terms,
  };

  try {
    const finalAnswer = await runAgent({
      prompt,
      sessionId,
      userId: opts.triggeredBy,
      project: topic.project,
      agent: topic.agent,
      llmCfg: cfg.llm,
      embedCfg: cfg.embed,
      memoryCfg: cfg.memory,
      agentCfg: cfg.agent,
      webCfg: cfg.web,
      tools,
      toolWhitelist: ["web_fetch", "web_search"],
      db,
      queue,
      renderer: silentRenderer(),
      originAutomation: true,
    });

    const parsed = extractNewsJson(finalAnswer);
    if (!parsed) {
      const msg = "model did not return a valid JSON block";
      result.error = msg;
      releaseTopic(db, topicId, {
        status: "error",
        error: msg,
        nextUpdateAt: safeNext(topic.updateCron, now),
        sessionId,
      });
      void queue.log({
        topic: "web_news",
        kind: "topic.run.parse_error",
        userId: opts.triggeredBy,
        data: { topicId, project: topic.project, sessionId },
        error: msg,
      });
      return result;
    }

    const capped = parsed.items.slice(0, topic.maxItemsPerRun);
    const insertedItems: ParsedNewsItem[] = [];
    for (const item of capped) {
      try {
        const { inserted } = upsertNewsItem(db, {
          topicId,
          project: topic.project,
          title: item.title,
          summary: item.summary,
          url: item.url,
          imageUrl: item.imageUrl,
          source: item.source,
          publishedAt: item.publishedAt,
          now,
        });
        if (inserted) {
          result.inserted++;
          insertedItems.push(item);
        } else {
          result.duplicates++;
        }
      } catch (e) {
        void queue.log({
          topic: "web_news",
          kind: "topic.item.upsert_error",
          userId: opts.triggeredBy,
          data: { topicId, project: topic.project, title: item.title },
          error: errorDetails(e),
        });
      }
    }

    const nextUpdate = safeNext(topic.updateCron, now);
    // When we ran in renew mode we must ALWAYS clear the trigger so a one-shot
    // regenerate (which zeroes next_renew_terms_at) doesn't re-fire forever:
    //   - with a cron configured: bump to its next fire
    //   - without one: clear to null
    // When we ran in fetch mode, leave next_renew_terms_at untouched.
    const nextRenew: number | null | undefined = renewTerms
      ? topic.renewTermsCron
        ? safeNext(topic.renewTermsCron, now)
        : null
      : undefined;
    const finalTerms =
      renewTerms && parsed.improvedTerms && parsed.improvedTerms.length > 0
        ? parsed.improvedTerms
        : undefined;

    releaseTopic(db, topicId, {
      status: "ok",
      error: null,
      nextUpdateAt: nextUpdate,
      nextRenewTermsAt: nextRenew,
      terms: finalTerms,
      sessionId,
    });
    result.terms = finalTerms ?? topic.terms;

    // Telegram digest: subscribers if any, else the topic creator (if any).
    // Only pings when the run actually produced *new* items — a tick that
    // only bumped seen_count would spam the chat for nothing.
    if (insertedItems.length > 0) {
      const digest = buildDigest(topic, insertedItems);
      const subs = listTopicSubscribers(db, topicId).map((s) => s.userId);
      const recipients =
        subs.length > 0 ? subs : topic.createdBy ? [topic.createdBy] : [];
      for (const uid of recipients) {
        void sendTelegramToUser(db, queue, cfg.telegram, {
          userId: uid,
          project: topic.project,
          text: digest,
          silent: true,
          source: "news_digest",
        });
      }
    }

    void queue.log({
      topic: "web_news",
      kind: "topic.run.done",
      userId: opts.triggeredBy,
      data: {
        topicId,
        project: topic.project,
        sessionId,
        inserted: result.inserted,
        duplicates: result.duplicates,
        mode: result.mode,
        termsCount: result.terms.length,
      },
    });

    return result;
  } catch (e) {
    const msg = errorDetails(e);
    result.error = msg;
    try {
      releaseTopic(db, topicId, {
        status: "error",
        error: msg,
        nextUpdateAt: safeNext(topic.updateCron, now),
        sessionId,
      });
    } catch {
      /* swallow — DB may have been closed in test teardown */
    }
    void queue.log({
      topic: "web_news",
      kind: "topic.run.error",
      userId: opts.triggeredBy,
      data: { topicId, project: topic.project, sessionId },
      error: msg,
    });
    return result;
  }
}

// ── Shared runner helpers ─────────────────────────────────────────────────────

interface RunnerOpts {
  db: Database;
  queue: BunnyQueue;
  cfg: BunnyConfig;
  tools: ToolRegistry;
  triggeredBy: string;
  now: number;
}

function notifySubscribers(
  db: Database,
  queue: BunnyQueue,
  cfg: BunnyConfig,
  topic: NewsTopic,
  insertedItems: ParsedNewsItem[],
): void {
  if (insertedItems.length === 0) return;
  const digest = buildDigest(topic, insertedItems);
  const subs = listTopicSubscribers(db, topic.id).map((s) => s.userId);
  const recipients =
    subs.length > 0 ? subs : topic.createdBy ? [topic.createdBy] : [];
  for (const uid of recipients) {
    void sendTelegramToUser(db, queue, cfg.telegram, {
      userId: uid,
      project: topic.project,
      text: digest,
      silent: true,
      source: "news_digest",
    });
  }
}

// ── RSS feed runner ───────────────────────────────────────────────────────────

async function runRssFeed(
  topic: NewsTopic,
  opts: RunnerOpts,
): Promise<RunTopicResult> {
  const { db, queue, triggeredBy, now } = opts;
  const result: RunTopicResult = {
    topicId: topic.id,
    sessionId: "",
    inserted: 0,
    duplicates: 0,
    mode: "rss",
    terms: [],
  };

  void queue.log({
    topic: "web_news",
    kind: "topic.run.start",
    userId: triggeredBy,
    data: { topicId: topic.id, project: topic.project, mode: "rss" },
  });

  try {
    const feedUrl = topic.feedUrl!;
    const res = await fetch(feedUrl, {
      headers: { "User-Agent": "Bunny-News/1.0" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching feed`);
    const xml = await res.text();
    const parsed = parseFeed(xml);
    if (!parsed) throw new Error("unrecognised feed format");

    // Summarise long/messy raw RSS content with the rss-news agent's LLM.
    const rawItems = parsed.items.slice(0, topic.maxItemsPerRun);
    const capped = await summariseRssItems(rawItems, opts.cfg.llm);
    const insertedItems: ParsedNewsItem[] = [];
    for (const item of capped) {
      try {
        const { inserted } = upsertNewsItem(db, {
          topicId: topic.id,
          project: topic.project,
          title: item.title,
          summary: item.summary,
          url: item.url,
          imageUrl: item.imageUrl,
          source: item.source ?? (parsed.feedTitle || null),
          publishedAt: item.publishedAt,
          now,
        });
        if (inserted) {
          result.inserted++;
          insertedItems.push({
            ...item,
            source: item.source ?? (parsed.feedTitle || null),
          });
        } else {
          result.duplicates++;
        }
      } catch (e) {
        void queue.log({
          topic: "web_news",
          kind: "topic.item.upsert_error",
          userId: triggeredBy,
          data: { topicId: topic.id, title: item.title },
          error: errorDetails(e),
        });
      }
    }

    releaseTopic(db, topic.id, {
      status: "ok",
      error: null,
      nextUpdateAt: safeNext(topic.updateCron, now),
    });

    notifySubscribers(db, queue, opts.cfg, topic, insertedItems);

    void queue.log({
      topic: "web_news",
      kind: "topic.run.done",
      userId: triggeredBy,
      data: {
        topicId: topic.id,
        project: topic.project,
        mode: "rss",
        inserted: result.inserted,
        duplicates: result.duplicates,
      },
    });
  } catch (e) {
    const msg = errorDetails(e);
    result.error = msg;
    try {
      releaseTopic(db, topic.id, {
        status: "error",
        error: msg,
        nextUpdateAt: safeNext(topic.updateCron, now),
      });
    } catch {
      /* swallow */
    }
    void queue.log({
      topic: "web_news",
      kind: "topic.run.error",
      userId: triggeredBy,
      data: { topicId: topic.id, project: topic.project, mode: "rss" },
      error: msg,
    });
  }

  return result;
}

// ── Site monitor runner ───────────────────────────────────────────────────────

async function runSiteMonitorTopic(
  topic: NewsTopic,
  opts: RunnerOpts,
): Promise<RunTopicResult> {
  const { db, queue, now } = opts;
  const result: RunTopicResult = {
    topicId: topic.id,
    sessionId: "",
    inserted: 0,
    duplicates: 0,
    mode: "site_monitor",
    terms: [],
  };

  void queue.log({
    topic: "web_news",
    kind: "topic.run.start",
    userId: opts.triggeredBy,
    data: { topicId: topic.id, project: topic.project, mode: "site_monitor" },
  });

  try {
    const monitorResult = await runSiteMonitor(topic, {
      db,
      queue,
      cfg: opts.cfg,
      tools: opts.tools,
      triggeredBy: opts.triggeredBy,
      now,
    });

    result.sessionId = monitorResult.sessionId ?? "";
    result.inserted = monitorResult.inserted;
    result.duplicates = monitorResult.duplicates;

    if (monitorResult.outcome === "llm_error") {
      result.error = "LLM extraction failed";
    }

    releaseTopic(db, topic.id, {
      status: monitorResult.outcome === "llm_error" ? "error" : "ok",
      error: result.error ?? null,
      nextUpdateAt: safeNext(topic.updateCron, now),
      sessionId: monitorResult.sessionId ?? undefined,
    });

    notifySubscribers(db, queue, opts.cfg, topic, monitorResult.insertedItems);

    void queue.log({
      topic: "web_news",
      kind: "topic.run.done",
      userId: opts.triggeredBy,
      data: {
        topicId: topic.id,
        project: topic.project,
        mode: "site_monitor",
        outcome: monitorResult.outcome,
        inserted: result.inserted,
      },
    });
  } catch (e) {
    const msg = errorDetails(e);
    result.error = msg;
    try {
      releaseTopic(db, topic.id, {
        status: "error",
        error: msg,
        nextUpdateAt: safeNext(topic.updateCron, now),
      });
    } catch {
      /* swallow */
    }
    void queue.log({
      topic: "web_news",
      kind: "topic.run.error",
      userId: opts.triggeredBy,
      data: { topicId: topic.id, project: topic.project, mode: "site_monitor" },
      error: msg,
    });
  }

  return result;
}

function safeNext(expr: string, now: number): number {
  try {
    return computeNextRun(expr, now);
  } catch {
    return now + 3_600_000;
  }
}

interface BuildUserMessageOpts {
  renewTerms: boolean;
  previousItems: ReturnType<typeof listRecentItemsForTopic>;
  /** Project name used to scope prompt registry overrides. */
  project: string;
  /** Current date as YYYY-MM-DD, injected into the prompt so the LLM knows what "recent" means. */
  today: string;
}

/**
 * Build the user message for a Web News run. Both the fetch instructions
 * and the renew-terms preamble come from the prompt registry
 * (`web_news.fetch`, `web_news.renew_terms`) so they are UI-editable. The
 * `{{topicName}}` / `{{termsText}}` / `{{known}}` / `{{maxItemsPerRun}}` /
 * `{{description}}` placeholders are interpolated here — the call site
 * composes renew+fetch by concatenation, same as the old inline template.
 */
function buildUserMessage(
  topic: NewsTopic,
  opts: BuildUserMessageOpts,
): string {
  const termsText =
    topic.terms.length > 0
      ? topic.terms.map((t) => JSON.stringify(t)).join(", ")
      : "(none)";
  const known = opts.previousItems.length
    ? opts.previousItems
        .map((i) => {
          const when = i.publishedAt
            ? new Date(i.publishedAt).toISOString()
            : new Date(i.firstSeenAt).toISOString();
          return `- ${i.title}${i.url ? ` — ${i.url}` : ""} (${when})`;
        })
        .join("\n")
    : "(none)";

  const description = topic.description.trim() || "(no description)";

  const fetchInstructions = interpolate(
    resolvePrompt("web_news.fetch", { project: opts.project }),
    {
      topicName: topic.name,
      today: opts.today,
      description,
      termsText,
      known,
      maxItemsPerRun: topic.maxItemsPerRun,
    },
  );

  if (!opts.renewTerms) return fetchInstructions;

  const renewPreamble = interpolate(
    resolvePrompt("web_news.renew_terms", { project: opts.project }),
    { topicName: topic.name },
  );
  return renewPreamble + fetchInstructions;
}

/**
 * Extract the JSON payload from the LLM's final answer. Delegates fence /
 * brace stripping to the shared `extractLlmJsonCandidates`; this caller's
 * own schema check (`items` array, optional `improvedTerms`) sits on top.
 */
export function extractNewsJson(raw: string): ParsedNewsPayload | null {
  for (const candidate of extractLlmJsonCandidates(raw)) {
    let obj: { items?: unknown; improvedTerms?: unknown };
    try {
      obj = JSON.parse(candidate) as typeof obj;
    } catch {
      continue;
    }
    const items = parseItems(obj?.items);
    if (items === null) continue;
    const improvedTerms = parseImprovedTerms(obj?.improvedTerms);
    return { items, improvedTerms };
  }
  return null;
}

function parseItems(raw: unknown): ParsedNewsItem[] | null {
  if (!Array.isArray(raw)) return null;
  const out: ParsedNewsItem[] = [];
  for (const it of raw) {
    if (!it || typeof it !== "object") continue;
    const rec = it as Record<string, unknown>;
    const rawTitle = rec["title"];
    const title = typeof rawTitle === "string" ? rawTitle.trim() : "";
    if (!title) continue;
    const rawSummary = rec["summary"];
    const rawSource = rec["source"];
    out.push({
      title,
      summary:
        typeof rawSummary === "string" ? rawSummary.trim().slice(0, 2000) : "",
      url: validHttpUrl(rec["url"]),
      imageUrl: validHttpUrl(rec["imageUrl"]),
      source: typeof rawSource === "string" ? rawSource.trim() || null : null,
      publishedAt: parseIsoDate(rec["publishedAt"]),
    });
  }
  return out;
}

function parseImprovedTerms(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const t of raw) {
    if (typeof t !== "string") continue;
    const trimmed = t.trim();
    if (trimmed) out.push(trimmed);
  }
  return out.length > 0 ? out : null;
}

function validHttpUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  return trimmed;
}

function parseIsoDate(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const ts = Date.parse(trimmed);
  return Number.isFinite(ts) ? ts : null;
}

const MAX_DIGEST_ITEMS = 5;

function buildDigest(topic: NewsTopic, items: ParsedNewsItem[]): string {
  const heading = `📰 **${topic.name}** — ${items.length} new item${items.length === 1 ? "" : "s"}`;
  const lines = items.slice(0, MAX_DIGEST_ITEMS).map((it) => {
    const title = it.title.trim();
    return it.url
      ? `• [${title}](${it.url})${it.source ? ` — ${it.source}` : ""}`
      : `• ${title}${it.source ? ` — ${it.source}` : ""}`;
  });
  if (items.length > MAX_DIGEST_ITEMS) {
    lines.push(`…and ${items.length - MAX_DIGEST_ITEMS} more in Bunny.`);
  }
  return `${heading}\n\n${lines.join("\n")}`;
}
