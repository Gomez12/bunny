/**
 * Web cookie session tokens stored in the `auth_sessions` table.
 */

import type { Database } from "bun:sqlite";
import { prep } from "../memory/prepared.ts";

const DEFAULT_TTL_HOURS = 168;
/** Minimum gap between `last_seen` writes; avoids a DB write on every request. */
const LAST_SEEN_THROTTLE_MS = 60_000;

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface AuthSession {
  token: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  lastSeen: number;
}

export function issueSession(
  db: Database,
  userId: string,
  ttlHours = DEFAULT_TTL_HOURS,
): AuthSession {
  const now = Date.now();
  const token = randomToken();
  const expiresAt = now + ttlHours * 3_600_000;
  prep(
    db,
    `INSERT INTO auth_sessions (token, user_id, created_at, expires_at, last_seen) VALUES (?, ?, ?, ?, ?)`,
  ).run(token, userId, now, expiresAt, now);
  return { token, userId, createdAt: now, expiresAt, lastSeen: now };
}

export function validateSession(
  db: Database,
  token: string,
): AuthSession | null {
  const row = prep(
    db,
    `SELECT token, user_id, created_at, expires_at, last_seen FROM auth_sessions WHERE token = ?`,
  ).get(token) as {
    token: string;
    user_id: string;
    created_at: number;
    expires_at: number;
    last_seen: number;
  } | null;
  if (!row) return null;
  const now = Date.now();
  if (row.expires_at < now) {
    revokeSession(db, token);
    return null;
  }
  // Throttle last_seen writes: the typical authed SPA fires one /api/* call
  // per user action, so without throttling we'd issue an UPDATE every time.
  // A 60s granularity is enough for "recently active" telemetry.
  let lastSeen = row.last_seen;
  if (now - row.last_seen >= LAST_SEEN_THROTTLE_MS) {
    prep(db, `UPDATE auth_sessions SET last_seen = ? WHERE token = ?`).run(
      now,
      token,
    );
    lastSeen = now;
  }
  return {
    token: row.token,
    userId: row.user_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastSeen,
  };
}

export function revokeSession(db: Database, token: string): void {
  prep(db, `DELETE FROM auth_sessions WHERE token = ?`).run(token);
}

export function revokeUserSessions(db: Database, userId: string): void {
  prep(db, `DELETE FROM auth_sessions WHERE user_id = ?`).run(userId);
}

export function sweepExpired(db: Database): number {
  const res = prep(db, `DELETE FROM auth_sessions WHERE expires_at < ?`).run(
    Date.now(),
  );
  return res.changes ?? 0;
}
