/**
 * RSS/Atom feed item summariser.
 *
 * After parsing a feed, raw summaries are often very long (full README text,
 * complete article bodies, etc.). This module batches all items into a single
 * LLM call and returns 2–3 sentence summaries, using the built-in `rss-news`
 * agent's model config. Falls back to simple truncation on error.
 */

import type { LlmConfig } from "../config.ts";
import { chatSync } from "../llm/adapter.ts";
import { NodeHtmlMarkdown } from "node-html-markdown";
import type { ParsedNewsItem } from "./run_topic.ts";

/** Items shorter than this are not sent to the LLM (already concise). */
const SHORT_THRESHOLD = 150;
/** Max chars of cleaned content sent per item to the LLM. */
const MAX_INPUT_CHARS = 800;
/** Max chars stored in the summary field after LLM processing. */
const MAX_STORED_CHARS = 500;

/**
 * Convert raw HTML/text content to clean plain text for LLM input.
 * RSS descriptions often contain HTML markup that needs stripping.
 */
function cleanForLlm(raw: string): string {
  // Use NodeHtmlMarkdown to convert HTML → markdown, then strip remaining markup
  const md = NodeHtmlMarkdown.translate(raw);
  // Collapse excessive whitespace and newlines
  return md
    .replace(/\n{3,}/g, "\n\n")
    .replace(/ {2,}/g, " ")
    .trim()
    .slice(0, MAX_INPUT_CHARS);
}

interface SummariseResult {
  index: number;
  summary: string;
}

function buildPrompt(items: Array<{ index: number; title: string; content: string }>): string {
  const itemList = items
    .map(
      (it) =>
        `[${it.index}] Title: ${it.title}\nContent: ${it.content || "(no content)"}`,
    )
    .join("\n---\n");

  return `Summarise each article into 2–3 clear, informative sentences.
Focus on what is new, notable, or useful. Write in plain text (no bullet points, no markdown).

Return a JSON array in exactly this format (same order and indices as input):
[{"index":0,"summary":"..."},{"index":1,"summary":"..."}]

Articles:
---
${itemList}`;
}

function isSummaryEntry(v: unknown): v is { index: number; summary: string } {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r["index"] === "number" && typeof r["summary"] === "string";
}

function parseLlmResponse(text: string, expectedCount: number): Map<number, string> {
  const result = new Map<number, string>();
  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return result;
    const arr = JSON.parse(jsonMatch[0]) as unknown[];
    for (const entry of arr) {
      if (isSummaryEntry(entry) && entry.index >= 0 && entry.index < expectedCount) {
        result.set(entry.index, entry.summary.trim().slice(0, MAX_STORED_CHARS));
      }
    }
  } catch {
    // malformed response — caller falls back to truncation
  }
  return result;
}

/**
 * Summarise RSS feed items using the LLM.
 * Items shorter than SHORT_THRESHOLD are passed through unchanged.
 * A single LLM call handles all long items in one batch.
 * On any error the original items are returned with summaries truncated to MAX_STORED_CHARS.
 */
export async function summariseRssItems(
  items: ParsedNewsItem[],
  llmCfg: LlmConfig,
): Promise<ParsedNewsItem[]> {
  // Identify which items need summarising
  const toLlm: Array<{ originalIndex: number; title: string; content: string }> = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (item.summary.length > SHORT_THRESHOLD) {
      toLlm.push({
        originalIndex: i,
        title: item.title,
        content: cleanForLlm(item.summary),
      });
    }
  }

  if (toLlm.length === 0) return items;

  const batchItems = toLlm.map((it, batchIdx) => ({
    index: batchIdx,
    title: it.title,
    content: it.content,
  }));

  // Build lookup map so the final items.map is O(n) not O(n²)
  const originalToBatch = new Map(toLlm.map((x, batchIdx) => [x.originalIndex, batchIdx]));

  let summaries = new Map<number, string>(); // batchIdx → summary
  try {
    const response = await chatSync(llmCfg, {
      model: llmCfg.model,
      messages: [{ role: "user", content: buildPrompt(batchItems) }],
    });
    summaries = parseLlmResponse(response.message.content ?? "", batchItems.length);
  } catch {
    // fall through to truncation fallback
  }

  return items.map((item, originalIndex) => {
    const batchIdx = originalToBatch.get(originalIndex);
    if (batchIdx === undefined) return item;
    const llmSummary = summaries.get(batchIdx);
    return llmSummary
      ? { ...item, summary: llmSummary }
      : { ...item, summary: item.summary.slice(0, MAX_STORED_CHARS) };
  });
}
