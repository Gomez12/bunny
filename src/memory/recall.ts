/**
 * Hybrid recall: Reciprocal Rank Fusion (RRF) over BM25 + vector search.
 *
 * RRF score for a document d:
 *   score(d) = Σ_r  1 / (k + rank_r(d))
 * where k=60 is the standard constant and rank_r(d) is 1-based position in
 * the sorted result list for ranker r.
 */

import type { Database } from "bun:sqlite";
import type { EmbedConfig } from "../config.ts";
import { searchBM25 } from "./bm25.ts";
import { searchVector } from "./vector.ts";
import { embed } from "./embed.ts";
import { getMessagesBySession } from "./messages.ts";
import type { StoredMessage } from "./messages.ts";

const RRF_K = 60;

export interface RecallResult {
  messageId: number;
  content: string | null;
  sessionId: string;
  rrfScore: number;
}

/**
 * Hybrid BM25 + vector recall using RRF.
 *
 * @param db        Open database instance.
 * @param embedCfg  Embedding config (for computing the query vector).
 * @param query     Natural-language query to recall against.
 * @param k         Number of results to return.
 * @param sessionId Optional session filter.
 */
export async function hybridRecall(
  db: Database,
  embedCfg: EmbedConfig,
  query: string,
  k = 8,
  sessionId?: string,
): Promise<RecallResult[]> {
  // Fetch more candidates per ranker so RRF has enough to merge.
  const fetchK = k * 4;

  // Run BM25 and vector searches in parallel.
  const [bm25Results, embedding] = await Promise.all([
    Promise.resolve(searchBM25(db, query, fetchK, sessionId)),
    embed(embedCfg, query),
  ]);
  const vectorResults = searchVector(db, embedding, fetchK);

  // Build per-message RRF scores.
  const scores = new Map<number, number>();

  for (const [rank, r] of bm25Results.entries()) {
    const prev = scores.get(r.messageId) ?? 0;
    scores.set(r.messageId, prev + 1 / (RRF_K + rank + 1));
  }

  for (const [rank, r] of vectorResults.entries()) {
    const prev = scores.get(r.messageId) ?? 0;
    scores.set(r.messageId, prev + 1 / (RRF_K + rank + 1));
  }

  // Sort by descending RRF score, take top-k.
  const sorted = [...scores.entries()]
    .sort(([, a], [, b]) => b - a)
    .slice(0, k);

  if (sorted.length === 0) return [];

  // Resolve message content (could query DB by IDs, but using what we already have).
  const bm25Map = new Map(bm25Results.map((r) => [r.messageId, r.content]));
  // For vector-only hits we need to fetch the content.
  const missingIds = sorted
    .map(([id]) => id)
    .filter((id) => !bm25Map.has(id));

  // Batch fetch missing content.
  const contentMap = new Map<number, string | null>(bm25Map);
  const sessionMap = new Map<number, string>(bm25Results.map((r) => [r.messageId, r.sessionId]));

  if (missingIds.length > 0) {
    // We don't have a "select by ID list" helper, so iterate sessions.
    // In practice this path only fires when a message appears in vector-but-not-BM25 results.
    for (const id of missingIds) {
      const placeholder = db
        .prepare(`SELECT content, session_id FROM messages WHERE id = ?`)
        .get(id) as { content: string | null; session_id: string } | undefined;
      if (placeholder) {
        contentMap.set(id, placeholder.content);
        sessionMap.set(id, placeholder.session_id);
      }
    }
  }

  return sorted.map(([id, score]) => ({
    messageId: id,
    content: contentMap.get(id) ?? null,
    sessionId: sessionMap.get(id) ?? "",
    rrfScore: score,
  }));
}
