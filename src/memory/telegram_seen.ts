/**
 * Inbound Telegram update_id dedup.
 *
 * Telegram will re-deliver an update whenever the previous delivery wasn't
 * confirmed (polling offset not advanced, webhook returned non-2xx, etc.).
 * Combined with our poison-message safety — advance `last_update_id` BEFORE
 * processing, so a malformed update can't wedge the bot — this table gives
 * us a belt-and-braces "already processed" check that's O(1).
 *
 * Entries are kept for 24 h and swept on each tick.
 *
 * See ADR 0028.
 */

import type { Database } from "bun:sqlite";

/** Insert the seen marker; returns true when the update is new. */
export function markSeen(
  db: Database,
  project: string,
  updateId: number,
  now: number,
): boolean {
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO telegram_seen_updates(project, update_id, seen_at)
       VALUES (?, ?, ?)`,
    )
    .run(project, updateId, now);
  return info.changes > 0;
}

export function sweepSeenUpdates(db: Database, olderThan: number): number {
  const info = db
    .prepare(`DELETE FROM telegram_seen_updates WHERE seen_at <= ?`)
    .run(olderThan);
  return info.changes;
}
