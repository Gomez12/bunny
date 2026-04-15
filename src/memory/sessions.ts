/**
 * Session queries — aggregate the `messages` table into per-session summaries
 * for the web UI "Messages" tab.
 *
 * A session is simply a distinct `session_id`. The title is derived from the
 * first user message in the session (truncated to 80 chars).
 */

import type { Database } from "bun:sqlite";
import { searchBM25 } from "./bm25.ts";

export interface SessionSummary {
  sessionId: string;
  title: string;
  firstTs: number;
  lastTs: number;
  messageCount: number;
  /** Owner of the first user message in the session (null for legacy rows). */
  userId: string | null;
  username: string | null;
  displayName: string | null;
  /** Project this session belongs to (defaults to 'general' for legacy rows). */
  project: string;
}

/**
 * List sessions ordered by most-recent activity first. Optionally filter to
 * sessions that contain at least one message matching `search` (BM25).
 */
export function listSessions(
  db: Database,
  opts: { limit?: number; search?: string; userId?: string; project?: string } = {},
): SessionSummary[] {
  const limit = opts.limit ?? 200;
  const search = opts.search?.trim();

  let sessionFilter: string[] | null = null;
  if (search) {
    const hits = searchBM25(db, search, 200, undefined, opts.project);
    sessionFilter = [...new Set(hits.map((h) => h.sessionId))];
    if (sessionFilter.length === 0) return [];
  }

  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (sessionFilter) {
    clauses.push(`m.session_id IN (${sessionFilter.map(() => "?").join(",")})`);
    params.push(...sessionFilter);
  }
  if (opts.userId) {
    clauses.push(`m.session_id IN (SELECT DISTINCT session_id FROM messages WHERE user_id = ?)`);
    params.push(opts.userId);
  }
  if (opts.project) {
    clauses.push(`COALESCE(m.project, 'general') = ?`);
    params.push(opts.project);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  // The title + owner come from a CTE over the first user-content message per
  // session, joined once — avoiding a correlated subquery that would re-scan
  // per group.
  const rows = db
    .prepare(
      `WITH first_user AS (
         SELECT session_id,
                substr(COALESCE(content, ''), 1, 80) AS title,
                user_id AS owner_id
         FROM (
           SELECT session_id, content, user_id,
                  ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY ts ASC) AS rn
           FROM messages
           WHERE role = 'user' AND channel = 'content'
         )
         WHERE rn = 1
       )
       SELECT
         m.session_id,
         MIN(m.ts) AS first_ts,
         MAX(m.ts) AS last_ts,
         COUNT(*)  AS n,
         fu.title  AS title,
         fu.owner_id AS owner_id,
         u.username AS owner_username,
         u.display_name AS owner_display_name,
         COALESCE(MAX(m.project), 'general') AS project
       FROM messages m
       LEFT JOIN first_user fu ON fu.session_id = m.session_id
       LEFT JOIN users u ON u.id = fu.owner_id
       ${where}
       GROUP BY m.session_id, fu.title, fu.owner_id, u.username, u.display_name
       ORDER BY last_ts DESC
       LIMIT ?`,
    )
    .all(...params, limit) as Array<{
    session_id: string;
    first_ts: number;
    last_ts: number;
    n: number;
    title: string | null;
    owner_id: string | null;
    owner_username: string | null;
    owner_display_name: string | null;
    project: string;
  }>;

  return rows.map((r) => ({
    sessionId: r.session_id,
    title: r.title?.trim() || "(untitled)",
    firstTs: r.first_ts,
    lastTs: r.last_ts,
    messageCount: r.n,
    userId: r.owner_id,
    username: r.owner_username,
    displayName: r.owner_display_name,
    project: r.project,
  }));
}

/**
 * Returns the set of user_ids that have written messages in a session. Used for
 * ownership checks in the web layer. Sessions without any `user_id` stamped
 * rows (legacy / anonymous) return an empty array.
 */
export function getSessionOwners(db: Database, sessionId: string): string[] {
  const rows = db
    .prepare(`SELECT DISTINCT user_id FROM messages WHERE session_id = ? AND user_id IS NOT NULL`)
    .all(sessionId) as Array<{ user_id: string }>;
  return rows.map((r) => r.user_id);
}
