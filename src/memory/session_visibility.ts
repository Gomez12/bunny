/**
 * Per-user session visibility — toggles whether a session shows up in *that
 * user's* chat sidebar. The Messages tab always shows everything they can
 * access, with hidden sessions styled distinctly.
 */

import type { Database } from "bun:sqlite";

export function setSessionHiddenFromChat(
  db: Database,
  userId: string,
  sessionId: string,
  hidden: boolean,
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO session_visibility (user_id, session_id, hidden_from_chat, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, session_id) DO UPDATE SET
       hidden_from_chat = excluded.hidden_from_chat,
       updated_at       = excluded.updated_at`,
  ).run(userId, sessionId, hidden ? 1 : 0, now);
}

export function isSessionHiddenFromChat(
  db: Database,
  userId: string,
  sessionId: string,
): boolean {
  const row = db
    .prepare(
      `SELECT hidden_from_chat AS h
       FROM session_visibility
       WHERE user_id = ? AND session_id = ?`,
    )
    .get(userId, sessionId) as { h: number } | null;
  return row?.h === 1;
}
