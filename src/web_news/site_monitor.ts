/**
 * Site monitor — 3-layer change detector for site_monitor topics.
 *
 * Layer 1: SHA-256 of raw HTML → compare to topic.lastHtmlHash
 *   unchanged → stop (no LLM call, no hash update)
 *   changed   → Layer 2
 *
 * Layer 2: Markdown of page → SHA-256 → compare to topic.lastMdHash
 *   unchanged → update lastHtmlHash only (caching-breaker skipped) → stop
 *   changed   → Layer 3
 *
 * Layer 3: Send markdown to LLM agent → extract news items
 *   → upsert items → update both hashes
 *
 * Using node-html-markdown (already a dep) for layer 2 ensures that
 * ephemeral HTML changes (timestamps, session tokens, ad rotation) don't
 * trigger LLM calls when the visible content hasn't changed.
 */

import type { Database } from "bun:sqlite";
import type { BunnyConfig } from "../config.ts";
import type { BunnyQueue } from "../queue/bunqueue.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import { NodeHtmlMarkdown } from "node-html-markdown";
import { sha256Hex } from "../util/hash.ts";
import { runAgent } from "../agent/loop.ts";
import { silentRenderer } from "../agent/render.ts";
import { setSessionHiddenFromChat } from "../memory/session_visibility.ts";
import { errorMessage } from "../util/error.ts";
import { upsertNewsItem, updateSiteHashes, type NewsTopic } from "../memory/web_news.ts";
import { extractNewsJson, type ParsedNewsItem } from "./run_topic.ts";

export interface SiteMonitorOpts {
  db: Database;
  queue: BunnyQueue;
  cfg: BunnyConfig;
  tools: ToolRegistry;
  triggeredBy: string;
  now: number;
}

export interface SiteMonitorResult {
  /** "unchanged_html" | "unchanged_md" | "no_content" | "llm_error" | "ok" */
  outcome: string;
  inserted: number;
  duplicates: number;
  sessionId: string | null;
  insertedItems: ParsedNewsItem[];
}

const TIMEOUT_MS = 30_000;
const MAX_MD_CHARS = 60_000;

async function fetchPage(url: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetch(url, {
      headers: { "User-Agent": "Bunny-SiteMonitor/1.0" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

export async function runSiteMonitor(
  topic: NewsTopic,
  opts: SiteMonitorOpts,
): Promise<SiteMonitorResult> {
  const { db, queue, cfg, tools, triggeredBy, now } = opts;
  const url = topic.siteUrl!;

  // ── Layer 1: raw HTML hash ────────────────────────────────────────────────
  const html = await fetchPage(url);
  if (!html) {
    return { outcome: "no_content", inserted: 0, duplicates: 0, sessionId: null, insertedItems: [] };
  }
  const htmlHash = sha256Hex(html);
  if (htmlHash === topic.lastHtmlHash) {
    return { outcome: "unchanged_html", inserted: 0, duplicates: 0, sessionId: null, insertedItems: [] };
  }

  // ── Layer 2: markdown hash ────────────────────────────────────────────────
  const md = NodeHtmlMarkdown.translate(html).slice(0, MAX_MD_CHARS);
  const mdHash = sha256Hex(md);
  if (mdHash === topic.lastMdHash) {
    // Only a caching-breaker changed (session tokens, timestamps, ads).
    // Update HTML hash so we don't re-check the markdown next time.
    updateSiteHashes(db, topic.id, htmlHash, topic.lastMdHash);
    return { outcome: "unchanged_md", inserted: 0, duplicates: 0, sessionId: null, insertedItems: [] };
  }

  // ── Layer 3: LLM extraction ───────────────────────────────────────────────
  const sessionId = `web-news-${crypto.randomUUID()}`;
  setSessionHiddenFromChat(db, triggeredBy, sessionId, true);

  const today = new Date(now).toISOString().slice(0, 10);
  const prompt = `You are monitoring the site: ${url}

Today is ${today}. Below is the current page content in Markdown.

Extract any notable news items, updates, announcements, or changes as structured JSON.
Each item must have a "title". Omit items without clear content.
Respond ONLY with a JSON block in this exact format:

\`\`\`json
{
  "items": [
    {
      "title": "string (required)",
      "summary": "string",
      "url": "https://... or null",
      "imageUrl": "https://... or null",
      "source": "string or null",
      "publishedAt": "ISO 8601 or null"
    }
  ],
  "improvedTerms": null
}
\`\`\`

Page content:

${md}`;

  const result: SiteMonitorResult = {
    outcome: "ok",
    inserted: 0,
    duplicates: 0,
    sessionId,
    insertedItems: [],
  };

  try {
    const finalAnswer = await runAgent({
      prompt,
      sessionId,
      userId: triggeredBy,
      project: topic.project,
      agent: topic.agent,
      llmCfg: cfg.llm,
      embedCfg: cfg.embed,
      memoryCfg: cfg.memory,
      agentCfg: cfg.agent,
      webCfg: undefined,
      tools,
      toolWhitelist: [],
      db,
      queue,
      renderer: silentRenderer(),
      originAutomation: true,
    });

    const parsed = extractNewsJson(finalAnswer);
    if (!parsed) {
      result.outcome = "llm_error";
      void queue.log({
        topic: "web_news",
        kind: "site_monitor.parse_error",
        userId: triggeredBy,
        data: { topicId: topic.id, project: topic.project, sessionId },
        error: "model did not return valid JSON",
      });
      return result;
    }

    const capped = parsed.items.slice(0, topic.maxItemsPerRun);
    for (const item of capped) {
      try {
        const { inserted } = upsertNewsItem(db, {
          topicId: topic.id,
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
          result.insertedItems.push(item);
        } else {
          result.duplicates++;
        }
      } catch (e) {
        void queue.log({
          topic: "web_news",
          kind: "site_monitor.upsert_error",
          userId: triggeredBy,
          data: { topicId: topic.id, title: item.title },
          error: errorMessage(e),
        });
      }
    }

    // Update both hashes only after a successful LLM pass.
    updateSiteHashes(db, topic.id, htmlHash, mdHash);
  } catch (e) {
    result.outcome = "llm_error";
    void queue.log({
      topic: "web_news",
      kind: "site_monitor.error",
      userId: triggeredBy,
      data: { topicId: topic.id, project: topic.project },
      error: errorMessage(e),
    });
  }

  return result;
}
