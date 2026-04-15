/**
 * Vector (kNN) search via sqlite-vec.
 *
 * Embeddings are stored in the `embeddings` vec0 virtual table. This module
 * provides nearest-neighbour lookups using cosine / L2 distance.
 */

import type { Database } from "bun:sqlite";
import { prep } from "./prepared.ts";

export interface VectorResult {
  messageId: number;
  distance: number;
}

/**
 * Find the `k` nearest messages to `queryEmbedding`.
 *
 * Returns an empty array when the embeddings table is not available (sqlite-vec
 * not loaded) or when there are no stored embeddings.
 *
 * @param queryEmbedding - Float32 embedding vector as a plain number array.
 * @param project - if provided, restrict results to this project (post-filter
 *                  after the vec0 kNN — so we over-fetch then narrow).
 */
export function searchVector(
  db: Database,
  queryEmbedding: number[],
  k = 8,
  project?: string,
  /** Restrict to user turns + assistant rows written by this author (or null for default). */
  ownAuthor?: string | null,
): VectorResult[] {
  // Serialize the query embedding to the binary format sqlite-vec expects.
  const queryBlob = float32ArrayToBlob(queryEmbedding);

  const needsPostFilter = project !== undefined || ownAuthor !== undefined;
  // vec0 does not support joins in the MATCH clause; over-fetch and post-filter.
  const fetchK = needsPostFilter ? k * 4 : k;

  try {
    // vec0 does not support joins inside a MATCH query, so we over-fetch and
    // post-filter. The kNN shape is fixed; cache its prepared statement.
    const rows = prep(
      db,
      `SELECT message_id, distance
       FROM embeddings
       WHERE embedding MATCH ?
         AND k = ?
       ORDER BY distance`,
    ).all(queryBlob, fetchK) as Array<{ message_id: number; distance: number }>;
    if (!needsPostFilter || rows.length === 0) {
      return rows.slice(0, k).map((r) => ({ messageId: r.message_id, distance: r.distance }));
    }
    const ids = rows.map((r) => r.message_id);
    const placeholders = ids.map(() => "?").join(",");
    const filterClauses: string[] = [`id IN (${placeholders})`];
    const filterParams: (string | number | null)[] = [...ids];
    if (project !== undefined) {
      filterClauses.push(`COALESCE(project, 'general') = ?`);
      filterParams.push(project);
    }
    if (ownAuthor !== undefined) {
      filterClauses.push(`(role = 'user' OR author IS ?)`);
      filterParams.push(ownAuthor ?? null);
    }
    // IN-list length varies per call, so the post-filter prepare cannot be
    // cached without bucketing; but vs. the kNN itself, parse time is a rounding
    // error. `prep` still benefits repeated hits for the same result set size.
    const allowed = prep(
      db,
      `SELECT id FROM messages WHERE ${filterClauses.join(" AND ")}`,
    ).all(...filterParams) as Array<{ id: number }>;
    const allowedSet = new Set(allowed.map((r) => r.id));
    return rows
      .filter((r) => allowedSet.has(r.message_id))
      .slice(0, k)
      .map((r) => ({ messageId: r.message_id, distance: r.distance }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Silently return empty on "no such module" (sqlite-vec absent) or empty table.
    if (msg.includes("no such module") || msg.includes("no such table")) return [];
    throw e;
  }
}

/**
 * Insert or replace a message's embedding.
 */
export function upsertEmbedding(db: Database, messageId: number, embedding: number[]): void {
  const blob = float32ArrayToBlob(embedding);
  try {
    prep(db, `INSERT OR REPLACE INTO embeddings(message_id, embedding) VALUES (?, ?)`).run(
      messageId,
      blob,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("no such module") || msg.includes("no such table")) return;
    throw e;
  }
}

/** Serialise a number[] to a little-endian Float32 Buffer that sqlite-vec accepts. */
export function float32ArrayToBlob(values: number[]): Buffer {
  const buf = Buffer.alloc(values.length * 4);
  for (let i = 0; i < values.length; i++) {
    buf.writeFloatLE(values[i]!, i * 4);
  }
  return buf;
}
