// Writes live in `src/queue/events.ts`; this module only queries.

import type { Database } from "bun:sqlite";

export interface EventRow {
  id: number;
  ts: number;
  topic: string;
  kind: string;
  sessionId: string | null;
  userId: string | null;
  durationMs: number | null;
  error: string | null;
  payloadJson: string | null;
}

export interface ListEventsFilter {
  topic?: string;
  kind?: string;
  sessionId?: string;
  userId?: string;
  errorsOnly?: boolean;
  fromTs?: number;
  toTs?: number;
  q?: string;
  limit?: number;
  offset?: number;
}

export interface ListEventsResult {
  items: EventRow[];
  total: number;
}

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

function buildWhere(f: ListEventsFilter): { sql: string; params: (string | number)[] } {
  const parts: string[] = [];
  const params: (string | number)[] = [];

  if (f.topic) {
    parts.push("topic = ?");
    params.push(f.topic);
  }
  if (f.kind) {
    parts.push("kind = ?");
    params.push(f.kind);
  }
  if (f.sessionId) {
    parts.push("session_id LIKE ?");
    params.push(`%${f.sessionId}%`);
  }
  if (f.userId) {
    parts.push("user_id LIKE ?");
    params.push(`%${f.userId}%`);
  }
  if (f.errorsOnly) {
    parts.push("error IS NOT NULL");
  }
  if (typeof f.fromTs === "number") {
    parts.push("ts >= ?");
    params.push(f.fromTs);
  }
  if (typeof f.toTs === "number") {
    parts.push("ts <= ?");
    params.push(f.toTs);
  }
  if (f.q) {
    parts.push("payload_json LIKE ?");
    params.push(`%${f.q}%`);
  }

  const sql = parts.length ? `WHERE ${parts.join(" AND ")}` : "";
  return { sql, params };
}

export function listEvents(db: Database, f: ListEventsFilter = {}): ListEventsResult {
  const { sql: where, params } = buildWhere(f);
  const limit = Math.min(Math.max(f.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(f.offset ?? 0, 0);

  const rows = db
    .prepare(
      `SELECT id, ts, topic, kind, session_id, user_id, duration_ms, error, payload_json
       FROM events
       ${where}
       ORDER BY ts DESC, id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as Array<{
    id: number;
    ts: number;
    topic: string;
    kind: string;
    session_id: string | null;
    user_id: string | null;
    duration_ms: number | null;
    error: string | null;
    payload_json: string | null;
  }>;

  const totalRow = db
    .prepare(`SELECT COUNT(*) AS n FROM events ${where}`)
    .get(...params) as { n: number } | undefined;

  return {
    items: rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      topic: r.topic,
      kind: r.kind,
      sessionId: r.session_id,
      userId: r.user_id,
      durationMs: r.duration_ms,
      error: r.error,
      payloadJson: r.payload_json,
    })),
    total: totalRow?.n ?? 0,
  };
}

export function listEventFacets(db: Database): { topics: string[]; kinds: string[] } {
  const topicRows = db
    .prepare(`SELECT DISTINCT topic FROM events WHERE topic IS NOT NULL ORDER BY topic ASC`)
    .all() as Array<{ topic: string }>;
  const kindRows = db
    .prepare(`SELECT DISTINCT kind FROM events WHERE kind IS NOT NULL ORDER BY kind ASC`)
    .all() as Array<{ kind: string }>;
  return {
    topics: topicRows.map((r) => r.topic),
    kinds: kindRows.map((r) => r.kind),
  };
}
