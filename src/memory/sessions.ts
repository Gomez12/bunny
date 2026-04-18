/**
 * Session queries — aggregate the `messages` table into per-session summaries
 * for the web UI "Messages" tab.
 *
 * A session is simply a distinct `session_id`. The title is derived from the
 * first user message in the session (truncated to 80 chars).
 */

import type { Database } from "bun:sqlite";
import { searchBM25 } from "./bm25.ts";
import { prep } from "./prepared.ts";
import { recordSessionFork } from "./session_visibility.ts";

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
  /** True iff the *viewer* has hidden this session from their chat sidebar.
   *  Always false when no `viewerId` is passed to listSessions. */
  hiddenFromChat: boolean;
  /** True iff the viewer has marked this session as a Quick Chat. */
  isQuickChat: boolean;
  /** Source session id when this session was created via "Fork to Quick Chat". */
  forkedFromSessionId: string | null;
}

/**
 * List sessions ordered by most-recent activity first. Optionally filter to
 * sessions that contain at least one message matching `search` (BM25).
 */
export function listSessions(
  db: Database,
  opts: {
    limit?: number;
    search?: string;
    userId?: string;
    project?: string;
    /** Authenticated viewer; used to surface their per-user `hiddenFromChat`. */
    viewerId?: string;
    /** When true, drop sessions the viewer has hidden from chat. Requires viewerId. */
    excludeHidden?: boolean;
  } = {},
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
    clauses.push(
      `m.session_id IN (SELECT DISTINCT session_id FROM messages WHERE user_id = ?)`,
    );
    params.push(opts.userId);
  }
  if (opts.project) {
    clauses.push(`COALESCE(m.project, 'general') = ?`);
    params.push(opts.project);
  }
  if (opts.excludeHidden && opts.viewerId) {
    clauses.push(
      `m.session_id NOT IN (SELECT session_id FROM session_visibility WHERE user_id = ? AND hidden_from_chat = 1)`,
    );
    params.push(opts.viewerId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  // Correlated lookup for title + owner of the first user-content row per
  // session. Backed by `idx_messages_user_session_ts` so each subquery is an
  // index seek rather than a table scan — previously the CTE ran ROW_NUMBER
  // over every user-content row in the DB.
  const visibilityJoin = opts.viewerId
    ? "LEFT JOIN session_visibility sv ON sv.session_id = agg.session_id AND sv.user_id = ?"
    : "";
  const visibilitySelect = opts.viewerId
    ? `COALESCE(sv.hidden_from_chat, 0) AS hidden,
       COALESCE(sv.is_quick_chat, 0) AS is_quick_chat,
       sv.forked_from_session_id AS forked_from_session_id`
    : `0 AS hidden, 0 AS is_quick_chat, NULL AS forked_from_session_id`;
  const aggWhere = where.replace(/\bm\./g, "");
  const aggClauses = aggWhere
    ? `${aggWhere} AND trimmed_at IS NULL`
    : `WHERE trimmed_at IS NULL`;

  const sql = `
    WITH agg AS (
      SELECT
        session_id,
        MIN(ts) AS first_ts,
        MAX(ts) AS last_ts,
        COUNT(*) AS n,
        COALESCE(MAX(project), 'general') AS project
      FROM messages
      ${aggClauses}
      GROUP BY session_id
      ORDER BY last_ts DESC
      LIMIT ?
    ),
    first_user AS (
      SELECT
        agg.session_id,
        (SELECT substr(COALESCE(content, ''), 1, 80)
           FROM messages
           WHERE session_id = agg.session_id AND role = 'user' AND channel = 'content'
             AND trimmed_at IS NULL
           ORDER BY ts ASC, id ASC
           LIMIT 1) AS title,
        (SELECT user_id
           FROM messages
           WHERE session_id = agg.session_id AND role = 'user' AND channel = 'content'
             AND trimmed_at IS NULL
           ORDER BY ts ASC, id ASC
           LIMIT 1) AS owner_id
      FROM agg
    )
    SELECT
      agg.session_id,
      agg.first_ts,
      agg.last_ts,
      agg.n,
      fu.title,
      fu.owner_id,
      u.username AS owner_username,
      u.display_name AS owner_display_name,
      agg.project,
      ${visibilitySelect}
    FROM agg
    LEFT JOIN first_user fu ON fu.session_id = agg.session_id
    LEFT JOIN users u ON u.id = fu.owner_id
    ${visibilityJoin}
    ORDER BY agg.last_ts DESC
  `;
  const stmtParams = opts.viewerId
    ? [...params, limit, opts.viewerId]
    : [...params, limit];
  const rows = prep(db, sql).all(...stmtParams) as Array<{
    session_id: string;
    first_ts: number;
    last_ts: number;
    n: number;
    title: string | null;
    owner_id: string | null;
    owner_username: string | null;
    owner_display_name: string | null;
    project: string;
    hidden: number;
    is_quick_chat: number;
    forked_from_session_id: string | null;
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
    hiddenFromChat: r.hidden === 1,
    isQuickChat: r.is_quick_chat === 1,
    forkedFromSessionId: r.forked_from_session_id ?? null,
  }));
}

/**
 * Returns the set of user_ids that have written messages in a session. Used for
 * ownership checks in the web layer. Sessions without any `user_id` stamped
 * rows (legacy / anonymous) return an empty array.
 */
/** In-process ACL cache for session owners (see getSessionOwners). */
const OWNERS_TTL_MS = 60_000;
const ownersCache = new WeakMap<
  Database,
  Map<string, { at: number; owners: string[] }>
>();

function ownersCacheFor(
  db: Database,
): Map<string, { at: number; owners: string[] }> {
  let m = ownersCache.get(db);
  if (!m) {
    m = new Map();
    ownersCache.set(db, m);
  }
  return m;
}

export function getSessionOwners(db: Database, sessionId: string): string[] {
  const cache = ownersCacheFor(db);
  const hit = cache.get(sessionId);
  const now = Date.now();
  if (hit && now - hit.at < OWNERS_TTL_MS) return hit.owners;
  // Ownership intentionally ignores trimmed_at — a user who has soft-deleted
  // their own contributions still owns the session for ACL purposes.
  const rows = prep(
    db,
    `SELECT DISTINCT user_id FROM messages WHERE session_id = ? AND user_id IS NOT NULL`,
  ).all(sessionId) as Array<{ user_id: string }>;
  const owners = rows.map((r) => r.user_id);
  cache.set(sessionId, { at: now, owners });
  return owners;
}

/**
 * Invalidate the owners cache for a session. The owner set is append-only in
 * practice, so this only needs to fire when a *new* user_id lands on a session.
 */
export function invalidateSessionOwners(db: Database, sessionId: string): void {
  const m = ownersCache.get(db);
  if (m) m.delete(sessionId);
}

export interface ForkSessionOpts {
  /** User performing the fork — becomes the owner of every copied row. */
  userId: string;
  /** Project the fork lands in. Defaults to the source session's project. */
  project?: string;
  /**
   * If set, only copy messages with `id <= untilMessageId` (inclusive).
   * NULL copies the whole session (excluding any rows that are already trimmed).
   */
  untilMessageId?: number | null;
  /** Mark the new session as a Quick Chat for the forking user. */
  asQuickChat?: boolean;
  /**
   * When set, overwrite the content of the last copied row in the new
   * session with this string. Used by the "edit then fork" affordance so
   * the user's draft lands in the fork without mutating the source row.
   */
  editLastMessageContent?: string;
}

export interface ForkSessionResult {
  sessionId: string;
  copiedCount: number;
  project: string;
}

/**
 * Copy a session's message history into a brand-new session id. Each copied
 * row is stamped with the caller's `userId` (so the new session shows up under
 * "Mine"); ts values are renumbered to (now + index*1ms) so chronological
 * order is preserved without colliding with the source. Trimmed and reasoning
 * rows are skipped — only the parts that round-trip cleanly back into the
 * agent loop are copied. Embeddings are NOT cloned in v1 (FTS picks up the
 * new rows automatically via the existing insert trigger).
 */
export function forkSession(
  db: Database,
  srcSessionId: string,
  opts: ForkSessionOpts,
): ForkSessionResult {
  const newSessionId = crypto.randomUUID();
  const now = Date.now();

  type SrcRow = {
    id: number;
    role: string;
    channel: string;
    content: string | null;
    tool_call_id: string | null;
    tool_name: string | null;
    provider_sig: string | null;
    ok: number | null;
    duration_ms: number | null;
    prompt_tokens: number | null;
    completion_tokens: number | null;
    project: string | null;
    author: string | null;
    attachments: string | null;
  };

  const rows = db
    .prepare(
      `SELECT id, role, channel, content, tool_call_id, tool_name, provider_sig,
              ok, duration_ms, prompt_tokens, completion_tokens, project, author,
              attachments
         FROM messages
        WHERE session_id = ?
          AND trimmed_at IS NULL
          AND (? IS NULL OR id <= ?)
        ORDER BY ts ASC, id ASC`,
    )
    .all(
      srcSessionId,
      opts.untilMessageId ?? null,
      opts.untilMessageId ?? null,
    ) as SrcRow[];

  const project =
    opts.project ?? rows.find((r) => r.project)?.project ?? "general";

  const insert = db.prepare(
    `INSERT INTO messages (
        session_id, ts, role, channel, content, tool_call_id, tool_name,
        provider_sig, ok, duration_ms, prompt_tokens, completion_tokens,
        user_id, project, author, attachments)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  let copied = 0;
  const lastIdx = rows.length - 1;
  const txn = db.transaction(() => {
    rows.forEach((r, idx) => {
      const content =
        idx === lastIdx && opts.editLastMessageContent !== undefined
          ? opts.editLastMessageContent
          : r.content;
      insert.run(
        newSessionId,
        now + idx,
        r.role,
        r.channel,
        content,
        r.tool_call_id,
        r.tool_name,
        r.provider_sig,
        r.ok,
        r.duration_ms,
        r.prompt_tokens,
        r.completion_tokens,
        opts.userId,
        project,
        r.author,
        r.attachments,
      );
      copied++;
    });
    recordSessionFork(
      db,
      opts.userId,
      newSessionId,
      { sessionId: srcSessionId, messageId: opts.untilMessageId ?? null },
      Boolean(opts.asQuickChat),
    );
  });
  txn();

  invalidateSessionOwners(db, newSessionId);
  return { sessionId: newSessionId, copiedCount: copied, project };
}
