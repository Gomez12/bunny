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

/** Toggle the per-user quick-chat flag for a session. */
export function setSessionQuickChat(
  db: Database,
  userId: string,
  sessionId: string,
  isQuickChat: boolean,
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO session_visibility (user_id, session_id, hidden_from_chat, is_quick_chat, updated_at)
     VALUES (?, ?, 0, ?, ?)
     ON CONFLICT(user_id, session_id) DO UPDATE SET
       is_quick_chat = excluded.is_quick_chat,
       updated_at    = excluded.updated_at`,
  ).run(userId, sessionId, isQuickChat ? 1 : 0, now);
}

/**
 * Mark a freshly-forked session: stamps the quick-chat flag plus the source
 * session/message ids that produced the fork. Used by `forkSession`.
 */
export function recordSessionFork(
  db: Database,
  userId: string,
  sessionId: string,
  src: { sessionId: string; messageId: number | null },
  asQuickChat: boolean,
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO session_visibility (
        user_id, session_id, hidden_from_chat, is_quick_chat,
        forked_from_session_id, forked_from_message_id, updated_at)
     VALUES (?, ?, 0, ?, ?, ?, ?)
     ON CONFLICT(user_id, session_id) DO UPDATE SET
       is_quick_chat          = excluded.is_quick_chat,
       forked_from_session_id = excluded.forked_from_session_id,
       forked_from_message_id = excluded.forked_from_message_id,
       updated_at             = excluded.updated_at`,
  ).run(
    userId,
    sessionId,
    asQuickChat ? 1 : 0,
    src.sessionId,
    src.messageId,
    now,
  );
}
