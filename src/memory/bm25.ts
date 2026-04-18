/**
 * BM25 full-text search via SQLite FTS5.
 *
 * The `messages_fts` virtual table mirrors `messages.content` where
 * `channel = 'content'`. This module wraps FTS5 MATCH queries with BM25
 * ranking (FTS5's default when using ORDER BY rank).
 */

import type { Database } from "bun:sqlite";

export interface BM25Result {
  messageId: number;
  sessionId: string;
  content: string | null;
  /** BM25 score (negative in SQLite FTS5 — lower = more relevant). */
  rank: number;
}

/**
 * Search messages using FTS5 BM25.
 *
 * @param query - FTS5 query string (plain text or FTS5 query syntax)
 * @param k - max results to return
 * @param sessionId - if provided, restrict to a single session
 * @param project - if provided, restrict to messages belonging to this project
 *                  (treats NULL project rows as 'general')
 */
export function searchBM25(
  db: Database,
  query: string,
  k = 8,
  sessionId?: string,
  project?: string,
  /** When set, only return rows written by this author or user turns. */
  ownAuthor?: string | null,
): BM25Result[] {
  if (!query.trim()) return [];

  // Escape special FTS5 characters to support plain-text queries.
  const escaped = escapeFts5(query);

  const clauses = ["messages_fts MATCH ?", "m.trimmed_at IS NULL"];
  const params: (string | number | null)[] = [escaped];
  if (sessionId) {
    clauses.push("m.session_id = ?");
    params.push(sessionId);
  }
  if (project) {
    clauses.push("COALESCE(m.project, 'general') = ?");
    params.push(project);
  }
  if (ownAuthor !== undefined) {
    clauses.push("(m.role = 'user' OR m.author IS ?)");
    params.push(ownAuthor ?? null);
  }
  const sql = `SELECT m.id, m.session_id, m.content, messages_fts.rank
       FROM messages_fts
       JOIN messages m ON messages_fts.rowid = m.id
       WHERE ${clauses.join(" AND ")}
       ORDER BY messages_fts.rank
       LIMIT ?`;
  params.push(k);
  const rows = db.prepare(sql).all(...params) as Array<{
    id: number;
    session_id: string;
    content: string | null;
    rank: number;
  }>;

  return rows.map((r) => ({
    messageId: r.id,
    sessionId: r.session_id,
    content: r.content,
    rank: r.rank,
  }));
}

/**
 * Prepare a plain-text query for FTS5 with the trigram tokenizer.
 *
 * The trigram tokenizer works on character n-grams, so phrase searches with
 * double-quotes break across word boundaries. Instead we pass the raw text
 * directly after stripping FTS5 special characters.
 */
function escapeFts5(s: string): string {
  // Remove FTS5 operator characters to prevent query syntax errors.
  return s.replace(/['"*^]/g, " ").trim();
}
