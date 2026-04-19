/**
 * Per-(user, project) Telegram chat links.
 *
 * A link binds one Telegram `chat_id` to one Bunny `user_id` scoped to a
 * project. Linking is per-project because the bot token itself is per-project
 * (different `@bot` per project → different chat ids). The composite PK
 * `(user_id, project)` means the same user can link to multiple projects; the
 * `(project, chat_id)` UNIQUE means a given chat maps to exactly one user.
 *
 * `current_session_id` is the rolling chat-session for this link. It survives
 * across messages so a Telegram conversation keeps context. Slash commands
 * `/new` and `/reset` clear it, which starts a fresh session on the next
 * inbound message.
 *
 * `busy_until` is a per-chat serialisation mutex: when an agent is
 * mid-response, a second message from the same chat must not spawn a parallel
 * `runAgent` racing the same session. See `tryAcquireMutex` below.
 *
 * See ADR 0028.
 */

import type { Database } from "bun:sqlite";

export interface TelegramLink {
  userId: string;
  project: string;
  chatId: number;
  tgUsername: string | null;
  currentSessionId: string | null;
  busyUntil: number;
  linkedAt: number;
}

interface LinkRow {
  user_id: string;
  project: string;
  chat_id: number;
  tg_username: string | null;
  current_session_id: string | null;
  busy_until: number;
  linked_at: number;
}

const COLS = `user_id, project, chat_id, tg_username,
              current_session_id, busy_until, linked_at`;

function rowToLink(r: LinkRow): TelegramLink {
  return {
    userId: r.user_id,
    project: r.project,
    chatId: r.chat_id,
    tgUsername: r.tg_username,
    currentSessionId: r.current_session_id,
    busyUntil: r.busy_until,
    linkedAt: r.linked_at,
  };
}

export function getLinkByChatId(
  db: Database,
  project: string,
  chatId: number,
): TelegramLink | null {
  const row = db
    .prepare(
      `SELECT ${COLS} FROM user_telegram_links WHERE project = ? AND chat_id = ?`,
    )
    .get(project, chatId) as LinkRow | undefined;
  return row ? rowToLink(row) : null;
}

export function getLinkByUser(
  db: Database,
  userId: string,
  project: string,
): TelegramLink | null {
  const row = db
    .prepare(
      `SELECT ${COLS} FROM user_telegram_links WHERE user_id = ? AND project = ?`,
    )
    .get(userId, project) as LinkRow | undefined;
  return row ? rowToLink(row) : null;
}

export function listLinksForUser(db: Database, userId: string): TelegramLink[] {
  const rows = db
    .prepare(
      `SELECT ${COLS} FROM user_telegram_links WHERE user_id = ? ORDER BY project ASC`,
    )
    .all(userId) as LinkRow[];
  return rows.map(rowToLink);
}

export function listLinksForProject(
  db: Database,
  project: string,
): TelegramLink[] {
  const rows = db
    .prepare(
      `SELECT ${COLS} FROM user_telegram_links WHERE project = ? ORDER BY user_id ASC`,
    )
    .all(project) as LinkRow[];
  return rows.map(rowToLink);
}

export interface CreateLinkOpts {
  userId: string;
  project: string;
  chatId: number;
  tgUsername?: string | null;
}

/**
 * Upsert a link. If a link already exists for the user/project, update the
 * chat_id; if a link exists for the chat_id in this project under a different
 * user, overwrite it (the new `/start <token>` wins).
 */
export function upsertLink(db: Database, opts: CreateLinkOpts): TelegramLink {
  const now = Date.now();
  // Clear any conflicting row owned by another user first (prevents
  // UNIQUE(project, chat_id) violation on re-pair).
  db.prepare(
    `DELETE FROM user_telegram_links
       WHERE project = ? AND chat_id = ? AND user_id != ?`,
  ).run(opts.project, opts.chatId, opts.userId);

  db.prepare(
    `INSERT INTO user_telegram_links(
       user_id, project, chat_id, tg_username,
       current_session_id, busy_until, linked_at
     ) VALUES (?, ?, ?, ?, NULL, 0, ?)
     ON CONFLICT(user_id, project) DO UPDATE SET
       chat_id = excluded.chat_id,
       tg_username = excluded.tg_username,
       linked_at = excluded.linked_at`,
  ).run(opts.userId, opts.project, opts.chatId, opts.tgUsername ?? null, now);
  return getLinkByUser(db, opts.userId, opts.project)!;
}

export function deleteLinkByUser(
  db: Database,
  userId: string,
  project: string,
): void {
  db.prepare(
    `DELETE FROM user_telegram_links WHERE user_id = ? AND project = ?`,
  ).run(userId, project);
}

export function setCurrentSession(
  db: Database,
  project: string,
  chatId: number,
  sessionId: string | null,
): void {
  db.prepare(
    `UPDATE user_telegram_links SET current_session_id = ?
       WHERE project = ? AND chat_id = ?`,
  ).run(sessionId, project, chatId);
}

/**
 * Try to acquire the per-chat serialisation mutex. Returns true on success.
 * `busyUntil` is the unix-ms after which the mutex self-expires — that's a
 * safety net in case the process crashes mid-response and never calls
 * `releaseMutex`.
 */
export function tryAcquireMutex(
  db: Database,
  project: string,
  chatId: number,
  ttlMs: number,
  now: number,
): boolean {
  const info = db
    .prepare(
      `UPDATE user_telegram_links
         SET busy_until = ?
       WHERE project = ? AND chat_id = ? AND busy_until <= ?`,
    )
    .run(now + ttlMs, project, chatId, now);
  return info.changes > 0;
}

export function releaseMutex(
  db: Database,
  project: string,
  chatId: number,
): void {
  db.prepare(
    `UPDATE user_telegram_links SET busy_until = 0
       WHERE project = ? AND chat_id = ?`,
  ).run(project, chatId);
}
