/**
 * Direct event log helpers.
 *
 * The queue middleware calls these to persist every job as a row in the
 * `events` table. All writes are synchronous (SQLite WAL) so they won't
 * block the Bun event loop for meaningful time.
 */

import type { Database } from "bun:sqlite";

export interface EventRecord {
  topic: string;
  kind: string;
  sessionId?: string;
  payloadJson?: string;
  durationMs?: number;
  error?: string;
}

export function insertEvent(db: Database, rec: EventRecord): void {
  db.prepare(
    `INSERT INTO events (ts, topic, kind, session_id, payload_json, duration_ms, error)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    Date.now(),
    rec.topic,
    rec.kind,
    rec.sessionId ?? null,
    rec.payloadJson ?? null,
    rec.durationMs ?? null,
    rec.error ?? null,
  );
}

/** Query recent events, optionally filtered by session and/or topic. */
export function queryEvents(
  db: Database,
  opts: { sessionId?: string; topic?: string; limit?: number },
): EventRecord[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (opts.sessionId) {
    conditions.push("session_id = ?");
    params.push(opts.sessionId);
  }
  if (opts.topic) {
    conditions.push("topic = ?");
    params.push(opts.topic);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = opts.limit ?? 100;

  const rows = db
    .prepare(`SELECT topic, kind, session_id, payload_json, duration_ms, error FROM events ${where} ORDER BY ts DESC LIMIT ?`)
    .all(...params, limit) as Array<{
    topic: string;
    kind: string;
    session_id: string | null;
    payload_json: string | null;
    duration_ms: number | null;
    error: string | null;
  }>;

  return rows.map((r) => ({
    topic: r.topic,
    kind: r.kind,
    sessionId: r.session_id ?? undefined,
    payloadJson: r.payload_json ?? undefined,
    durationMs: r.duration_ms ?? undefined,
    error: r.error ?? undefined,
  }));
}
