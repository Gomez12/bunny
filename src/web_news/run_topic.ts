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

import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { BunnyConfig } from "../config.ts";
import type { BunnyQueue } from "../queue/bunqueue.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import { runAgent } from "../agent/loop.ts";
import { silentRenderer } from "../agent/render.ts";
import { setSessionHiddenFromChat } from "../memory/session_visibility.ts";
import { errorMessage } from "../util/error.ts";
import { computeNextRun } from "../scheduler/cron.ts";
import {
  claimTopicForRun,
  getTopic,
  listRecentItemsForTopic,
  releaseTopic,
  upsertNewsItem,
  type NewsTopic,
} from "../memory/web_news.ts";

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
  mode: "fetch" | "renew+fetch";
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
  const needsRenewByCron =
    topic.nextRenewTermsAt !== null && topic.nextRenewTermsAt <= now;
  const renewTerms =
    topic.terms.length === 0 ||
    topic.alwaysRegenerateTerms ||
    needsRenewByCron;

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

  const sessionId = `web-news-${randomUUID()}`;
  setSessionHiddenFromChat(db, opts.triggeredBy, sessionId, true);

  const prompt = buildUserMessage(topic, {
    renewTerms,
    previousItems: listRecentItemsForTopic(db, topicId, 30),
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
      db,
      queue,
      renderer: silentRenderer(),
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
        if (inserted) result.inserted++;
        else result.duplicates++;
      } catch (e) {
        void queue.log({
          topic: "web_news",
          kind: "topic.item.upsert_error",
          userId: opts.triggeredBy,
          data: { topicId, project: topic.project, title: item.title },
          error: errorMessage(e),
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
    const msg = errorMessage(e);
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
}

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

  const fetchInstructions = `Gather the latest news on topic "${topic.name}".
Description: ${description}
Search terms to use: ${termsText}

Previous items already known — DO NOT repeat these; only return items whose
titles and URLs differ meaningfully:
${known}

Use web_search (and web_fetch when a hit looks promising) to find items
published in the last few days that are NOT in the known list. Prefer primary
sources. Cap at ${topic.maxItemsPerRun} truly-novel items.

Output format — return EXACTLY ONE fenced \`\`\`json\`\`\` block and nothing else:

\`\`\`json
{
  "items": [
    {
      "title": "string",
      "summary": "1-3 sentences in plain text",
      "url": "https://... or null",
      "imageUrl": "https://... or null",
      "source": "publication or site name, or null",
      "publishedAt": "ISO-8601 date/time or null"
    }
  ]
}
\`\`\`

Do not add prose before or after the JSON block. Return an empty items array if
you cannot find anything new.`;

  if (!opts.renewTerms) return fetchInstructions;

  return `Current terms are empty or stale for topic "${topic.name}". First use web_search
to explore the landscape and propose an improved term set, then fetch news
using those new terms.

Your JSON output for this combined run must use this shape (still ONE fenced
\`\`\`json\`\`\` block, nothing before or after):

\`\`\`json
{
  "improvedTerms": ["high-signal phrase 1", "high-signal phrase 2"],
  "items": [
    { "title": "...", "summary": "...", "url": "...", "imageUrl": null,
      "source": null, "publishedAt": null }
  ]
}
\`\`\`

Keep improvedTerms to 3-7 items. ${fetchInstructions}`;
}

/**
 * Extract the JSON payload from the LLM's final answer. Accepts `\`\`\`json`,
 * bare ``` ``` ``` fences, or a raw `{...}` block. Mirrors
 * `src/server/kb_routes.ts:extractDefinitionJson`.
 */
export function extractNewsJson(raw: string): ParsedNewsPayload | null {
  const candidates: string[] = [];
  const fencedJson = raw.match(/```json\s*\n([\s\S]*?)\n```/);
  if (fencedJson?.[1]) candidates.push(fencedJson[1]);
  const fencedBare = raw.match(/```\s*\n([\s\S]*?)\n```/);
  if (fencedBare?.[1]) candidates.push(fencedBare[1]);
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(raw.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const obj = JSON.parse(candidate.trim());
      const items = parseItems(obj?.items);
      if (items === null) continue;
      const improvedTerms = parseImprovedTerms(obj?.improvedTerms);
      return { items, improvedTerms };
    } catch {
      continue;
    }
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
      source:
        typeof rawSource === "string" ? rawSource.trim() || null : null,
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
