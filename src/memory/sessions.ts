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
}

/**
 * List sessions ordered by most-recent activity first. Optionally filter to
 * sessions that contain at least one message matching `search` (BM25).
 */
export function listSessions(
  db: Database,
  opts: { limit?: number; search?: string } = {},
): SessionSummary[] {
  const limit = opts.limit ?? 200;
  const search = opts.search?.trim();

  let sessionFilter: string[] | null = null;
  if (search) {
    const hits = searchBM25(db, search, 200);
    sessionFilter = [...new Set(hits.map((h) => h.sessionId))];
    if (sessionFilter.length === 0) return [];
  }

  const where = sessionFilter
    ? `WHERE session_id IN (${sessionFilter.map(() => "?").join(",")})`
    : "";

  // The title comes from a CTE over the first user-content message per session,
  // joined once — avoiding a correlated subquery that would re-scan per group.
  const rows = db
    .prepare(
      `WITH first_user AS (
         SELECT session_id, substr(COALESCE(content, ''), 1, 80) AS title
         FROM (
           SELECT session_id, content,
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
         fu.title  AS title
       FROM messages m
       LEFT JOIN first_user fu ON fu.session_id = m.session_id
       ${where.replace(/session_id/g, "m.session_id")}
       GROUP BY m.session_id, fu.title
       ORDER BY last_ts DESC
       LIMIT ?`,
    )
    .all(...(sessionFilter ?? []), limit) as Array<{
    session_id: string;
    first_ts: number;
    last_ts: number;
    n: number;
    title: string | null;
  }>;

  return rows.map((r) => ({
    sessionId: r.session_id,
    title: r.title?.trim() || "(untitled)",
    firstTs: r.first_ts,
    lastTs: r.last_ts,
    messageCount: r.n,
  }));
}
