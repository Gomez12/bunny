/**
 * One-time pending link tokens for Telegram chat pairing.
 *
 * Flow:
 *   1. User clicks "New Telegram link" in Settings. The server generates a
 *      token, writes it here with a 15-min TTL, and shows the user a
 *      `https://t.me/<bot>?start=<token>` deep-link.
 *   2. In Telegram, the user taps that link → sends `/start <token>`.
 *   3. The bot's inbound handler `consumePendingLink` swaps the token for a
 *      real `user_telegram_links` row and deletes the pending token.
 *
 * Tokens are deleted on use or on expiry. A background sweep (called on every
 * successful consume) wipes expired rows so the table stays tiny.
 *
 * See ADR 0028.
 */

import { randomBytes } from "node:crypto";
import type { Database } from "bun:sqlite";

export interface PendingLink {
  linkToken: string;
  userId: string;
  project: string;
  expiresAt: number;
  createdAt: number;
}

interface PendingRow {
  link_token: string;
  user_id: string;
  project: string;
  expires_at: number;
  created_at: number;
}

function rowToPending(r: PendingRow): PendingLink {
  return {
    linkToken: r.link_token,
    userId: r.user_id,
    project: r.project,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
  };
}

/** Default TTL is 15 minutes. */
export const DEFAULT_PENDING_TTL_MS = 15 * 60 * 1000;

export function createPendingLink(
  db: Database,
  opts: { userId: string; project: string; ttlMs?: number },
): PendingLink {
  const now = Date.now();
  const ttl = opts.ttlMs ?? DEFAULT_PENDING_TTL_MS;
  // 20 bytes → 40 hex chars. Short enough to type in Telegram, long enough
  // to be unguessable.
  const token = randomBytes(20).toString("hex");
  db.prepare(
    `INSERT INTO telegram_pending_links(link_token, user_id, project, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(token, opts.userId, opts.project, now + ttl, now);
  return {
    linkToken: token,
    userId: opts.userId,
    project: opts.project,
    expiresAt: now + ttl,
    createdAt: now,
  };
}

export function getPendingLink(
  db: Database,
  token: string,
  now: number,
): PendingLink | null {
  const row = db
    .prepare(
      `SELECT link_token, user_id, project, expires_at, created_at
         FROM telegram_pending_links
        WHERE link_token = ? AND expires_at > ?`,
    )
    .get(token, now) as PendingRow | undefined;
  return row ? rowToPending(row) : null;
}

export function deletePendingLink(db: Database, token: string): void {
  db.prepare(`DELETE FROM telegram_pending_links WHERE link_token = ?`).run(
    token,
  );
}

/** Remove expired rows. Called opportunistically on every `consume`. */
export function sweepExpiredPendingLinks(db: Database, now: number): number {
  const info = db
    .prepare(`DELETE FROM telegram_pending_links WHERE expires_at <= ?`)
    .run(now);
  return info.changes;
}
