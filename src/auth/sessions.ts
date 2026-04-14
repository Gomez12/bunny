/**
 * Web cookie session tokens stored in the `auth_sessions` table.
 */

import type { Database } from "bun:sqlite";

const DEFAULT_TTL_HOURS = 168;

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

export function issueSession(db: Database, userId: string, ttlHours = DEFAULT_TTL_HOURS): AuthSession {
  const now = Date.now();
  const token = randomToken();
  const expiresAt = now + ttlHours * 3_600_000;
  db.prepare(
    `INSERT INTO auth_sessions (token, user_id, created_at, expires_at, last_seen) VALUES (?, ?, ?, ?, ?)`,
  ).run(token, userId, now, expiresAt, now);
  return { token, userId, createdAt: now, expiresAt, lastSeen: now };
}

export function validateSession(db: Database, token: string): AuthSession | null {
  const row = db
    .prepare(`SELECT token, user_id, created_at, expires_at, last_seen FROM auth_sessions WHERE token = ?`)
    .get(token) as
    | { token: string; user_id: string; created_at: number; expires_at: number; last_seen: number }
    | null;
  if (!row) return null;
  const now = Date.now();
  if (row.expires_at < now) {
    revokeSession(db, token);
    return null;
  }
  db.prepare(`UPDATE auth_sessions SET last_seen = ? WHERE token = ?`).run(now, token);
  return {
    token: row.token,
    userId: row.user_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastSeen: now,
  };
}

export function revokeSession(db: Database, token: string): void {
  db.prepare(`DELETE FROM auth_sessions WHERE token = ?`).run(token);
}

export function revokeUserSessions(db: Database, userId: string): void {
  db.prepare(`DELETE FROM auth_sessions WHERE user_id = ?`).run(userId);
}

export function sweepExpired(db: Database): number {
  const res = db.prepare(`DELETE FROM auth_sessions WHERE expires_at < ?`).run(Date.now());
  return res.changes ?? 0;
}
