/**
 * Per-user news interests soul.
 *
 * A lightweight, stable profile of a user's news interests built from their
 * 👍/👎 reactions. Refreshed every 6 h (configurable). The main user soul
 * reads this as a stable reference so individual reaction events don't cause
 * large swings in the general soul.
 *
 * State machine: idle → refreshing → (idle | error)
 * Stuck rows (process death mid-refresh) are reclaimed at the start of each tick.
 */

import type { Database } from "bun:sqlite";

const STUCK_THRESHOLD_MS = 60 * 60 * 1000; // 1 h

interface NewsSoulRow {
  id: string;
  news_soul: string;
  news_soul_status: string;
  news_soul_error: string | null;
  news_soul_refreshed_at: number | null;
  news_soul_refreshing_at: number | null;
}

export interface UserNewsSoul {
  userId: string;
  soul: string;
  status: "idle" | "refreshing" | "error";
  error: string | null;
  refreshedAt: number | null;
  refreshingAt: number | null;
}

function rowToNewsSoul(r: NewsSoulRow): UserNewsSoul {
  const status =
    r.news_soul_status === "refreshing"
      ? "refreshing"
      : r.news_soul_status === "error"
        ? "error"
        : "idle";
  return {
    userId: r.id,
    soul: r.news_soul,
    status,
    error: r.news_soul_error,
    refreshedAt: r.news_soul_refreshed_at,
    refreshingAt: r.news_soul_refreshing_at,
  };
}

export function getUserNewsSoul(db: Database, userId: string): UserNewsSoul | null {
  const row = db
    .prepare(
      `SELECT id, news_soul, news_soul_status, news_soul_error,
              news_soul_refreshed_at, news_soul_refreshing_at
         FROM users WHERE id = ?`,
    )
    .get(userId) as NewsSoulRow | undefined;
  return row ? rowToNewsSoul(row) : null;
}

/**
 * Persist the LLM-merged news soul. When the model returns empty content,
 * the existing `news_soul` column is left untouched — only the status
 * metadata advances. Prevents a flaky refresh from wiping the profile.
 */
export function setUserNewsSoulAuto(db: Database, userId: string, soul: string): void {
  const trimmed = soul.trim();
  const now = Date.now();
  if (trimmed) {
    db.prepare(
      `UPDATE users
          SET news_soul = ?, news_soul_status = 'idle', news_soul_error = NULL,
              news_soul_refreshed_at = ?, news_soul_refreshing_at = NULL,
              updated_at = ?
        WHERE id = ?`,
    ).run(trimmed, now, now, userId);
  } else {
    db.prepare(
      `UPDATE users
          SET news_soul_status = 'idle', news_soul_error = NULL,
              news_soul_refreshed_at = ?, news_soul_refreshing_at = NULL,
              updated_at = ?
        WHERE id = ?`,
    ).run(now, now, userId);
  }
}

export function setUserNewsSoulError(db: Database, userId: string, error: string): void {
  const now = Date.now();
  db.prepare(
    `UPDATE users
        SET news_soul_status = 'error', news_soul_error = ?,
            news_soul_refreshing_at = NULL, updated_at = ?
      WHERE id = ?`,
  ).run(error, now, userId);
}

/** Atomically claim a user for news soul refresh. Returns false when already refreshing. */
export function claimUserNewsSoulForRefresh(db: Database, userId: string): boolean {
  const now = Date.now();
  const info = db
    .prepare(
      `UPDATE users
          SET news_soul_status = 'refreshing', news_soul_refreshing_at = ?, updated_at = ?
        WHERE id = ? AND news_soul_status != 'refreshing'`,
    )
    .run(now, now, userId);
  return info.changes > 0;
}

/** Reclaim users whose news soul refresh has been stuck longer than the threshold. */
export function releaseStuckNewsSouls(db: Database): number {
  const cutoff = Date.now() - STUCK_THRESHOLD_MS;
  const info = db
    .prepare(
      `UPDATE users
          SET news_soul_status = 'idle', news_soul_error = 'stuck reclaim',
              news_soul_refreshing_at = NULL
        WHERE news_soul_status = 'refreshing'
          AND news_soul_refreshing_at IS NOT NULL
          AND news_soul_refreshing_at < ?`,
    )
    .run(cutoff);
  return info.changes;
}

/**
 * Users who have received new reactions since their last news-soul refresh
 * and are not currently being processed.
 */
export function listUsersDueForNewsSoulRefresh(
  db: Database,
  minReactionsSince = 3,
  limit = 20,
): Array<{ userId: string; reactionCount: number; lastRefreshedAt: number | null }> {
  return db
    .prepare(
      `SELECT u.id AS userId,
              u.news_soul_refreshed_at AS lastRefreshedAt,
              COUNT(r.item_id) AS reactionCount
         FROM users u
         JOIN web_news_item_reactions r ON r.user_id = u.id
        WHERE u.news_soul_status != 'refreshing'
          AND (
            u.news_soul_refreshed_at IS NULL
            OR r.created_at > u.news_soul_refreshed_at
          )
        GROUP BY u.id
       HAVING COUNT(r.item_id) >= ?
        ORDER BY reactionCount DESC
        LIMIT ?`,
    )
    .all(minReactionsSince, limit) as Array<{
    userId: string;
    reactionCount: number;
    lastRefreshedAt: number | null;
  }>;
}
