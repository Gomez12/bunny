/**
 * Vector (kNN) search via sqlite-vec.
 *
 * Embeddings are stored in the `embeddings` vec0 virtual table. This module
 * provides nearest-neighbour lookups using cosine / L2 distance.
 */

import type { Database } from "bun:sqlite";

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
 */
export function searchVector(db: Database, queryEmbedding: number[], k = 8): VectorResult[] {
  // Serialize the query embedding to the binary format sqlite-vec expects.
  const queryBlob = float32ArrayToBlob(queryEmbedding);

  try {
    const rows = db
      .prepare(
        `SELECT message_id, distance
         FROM embeddings
         WHERE embedding MATCH ?
           AND k = ?
         ORDER BY distance`,
      )
      .all(queryBlob, k) as Array<{ message_id: number; distance: number }>;
    return rows.map((r) => ({ messageId: r.message_id, distance: r.distance }));
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
    db.prepare(
      `INSERT OR REPLACE INTO embeddings(message_id, embedding) VALUES (?, ?)`,
    ).run(messageId, blob);
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
