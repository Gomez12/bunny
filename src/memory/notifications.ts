/**
 * User notifications — CRUD against the `notifications` table.
 *
 * Per-user (cross-project) rows. v1 creates rows with kind 'mention' (one per
 * mentioned recipient) or 'mention_blocked' (one per sender when recipients
 * could not be reached due to project visibility). The shape is deliberately
 * permissive — future triggers (`card_assigned`, `task_completed`, …) reuse
 * the same table. See ADR 0027.
 */

import type { Database } from "bun:sqlite";

export const MAX_NOTIFICATIONS_PER_USER = 200;

export type NotificationKind = "mention" | "mention_blocked" | (string & {});

export interface Notification {
  id: number;
  userId: string;
  kind: NotificationKind;
  title: string;
  body: string;
  actorUserId: string | null;
  actorUsername: string | null;
  actorDisplayName: string | null;
  project: string | null;
  sessionId: string | null;
  messageId: number | null;
  deepLink: string;
  readAt: number | null;
  createdAt: number;
}

interface NotificationRow {
  id: number;
  user_id: string;
  kind: string;
  title: string;
  body: string;
  actor_user_id: string | null;
  actor_username: string | null;
  actor_display_name: string | null;
  project: string | null;
  session_id: string | null;
  message_id: number | null;
  deep_link: string;
  read_at: number | null;
  created_at: number;
}

const SELECT_COLS = `id, user_id, kind, title, body, actor_user_id, actor_username,
                     actor_display_name, project, session_id, message_id,
                     deep_link, read_at, created_at`;

function rowToNotification(r: NotificationRow): Notification {
  return {
    id: r.id,
    userId: r.user_id,
    kind: r.kind,
    title: r.title,
    body: r.body,
    actorUserId: r.actor_user_id,
    actorUsername: r.actor_username,
    actorDisplayName: r.actor_display_name,
    project: r.project,
    sessionId: r.session_id,
    messageId: r.message_id,
    deepLink: r.deep_link,
    readAt: r.read_at,
    createdAt: r.created_at,
  };
}

export interface CreateNotificationOpts {
  userId: string;
  kind: NotificationKind;
  title: string;
  body?: string;
  actorUserId?: string | null;
  actorUsername?: string | null;
  actorDisplayName?: string | null;
  project?: string | null;
  sessionId?: string | null;
  messageId?: number | null;
  deepLink?: string;
}

/**
 * Insert a notification and prune the user's list back to
 * {@link MAX_NOTIFICATIONS_PER_USER} newest rows in the same transaction.
 */
export function createNotification(
  db: Database,
  opts: CreateNotificationOpts,
): Notification {
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO notifications (user_id, kind, title, body, actor_user_id,
          actor_username, actor_display_name, project, session_id, message_id,
          deep_link, read_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    )
    .run(
      opts.userId,
      opts.kind,
      opts.title,
      opts.body ?? "",
      opts.actorUserId ?? null,
      opts.actorUsername ?? null,
      opts.actorDisplayName ?? null,
      opts.project ?? null,
      opts.sessionId ?? null,
      opts.messageId ?? null,
      opts.deepLink ?? "",
      now,
    );
  const id = Number(info.lastInsertRowid);

  // Prune back to the newest MAX rows per user so the panel stays bounded.
  db.prepare(
    `DELETE FROM notifications
       WHERE user_id = ?
         AND id NOT IN (
           SELECT id FROM notifications
            WHERE user_id = ?
            ORDER BY created_at DESC, id DESC
            LIMIT ?
         )`,
  ).run(opts.userId, opts.userId, MAX_NOTIFICATIONS_PER_USER);

  const created = getNotification(db, id);
  if (!created) {
    // Insert succeeded but the pruner removed the row we just added. That can
    // only happen if MAX is 0; treat it as a logic error.
    throw new Error("notification pruned immediately after insert");
  }
  return created;
}

export function getNotification(
  db: Database,
  id: number,
): Notification | null {
  const row = db
    .prepare(`SELECT ${SELECT_COLS} FROM notifications WHERE id = ?`)
    .get(id) as NotificationRow | null;
  return row ? rowToNotification(row) : null;
}

export interface ListNotificationsOpts {
  unreadOnly?: boolean;
  limit?: number;
  before?: number; // id cursor — returns rows with id < before
}

export function listForUser(
  db: Database,
  userId: string,
  opts: ListNotificationsOpts = {},
): Notification[] {
  const limit = Math.min(opts.limit ?? 50, 200);
  const clauses = ["user_id = ?"];
  const params: (string | number)[] = [userId];
  if (opts.unreadOnly) clauses.push("read_at IS NULL");
  if (typeof opts.before === "number") {
    clauses.push("id < ?");
    params.push(opts.before);
  }
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLS} FROM notifications
        WHERE ${clauses.join(" AND ")}
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
    .all(...params, limit) as NotificationRow[];
  return rows.map(rowToNotification);
}

export function getUnreadCount(db: Database, userId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM notifications
        WHERE user_id = ? AND read_at IS NULL`,
    )
    .get(userId) as { n: number };
  return row.n;
}

/**
 * Mark one notification as read — but only if it belongs to `userId`. Returns
 * the read timestamp, or null if the row doesn't exist / isn't theirs / was
 * already read.
 */
export function markRead(
  db: Database,
  id: number,
  userId: string,
): number | null {
  const now = Date.now();
  const info = db
    .prepare(
      `UPDATE notifications SET read_at = ?
        WHERE id = ? AND user_id = ? AND read_at IS NULL`,
    )
    .run(now, id, userId);
  return info.changes > 0 ? now : null;
}

/** Mark every unread notification for this user read; returns the timestamp. */
export function markAllRead(db: Database, userId: string): number {
  const now = Date.now();
  db.prepare(
    `UPDATE notifications SET read_at = ?
      WHERE user_id = ? AND read_at IS NULL`,
  ).run(now, userId);
  return now;
}

/** Delete a notification — only if it belongs to `userId`. */
export function deleteNotification(
  db: Database,
  id: number,
  userId: string,
): boolean {
  const info = db
    .prepare(`DELETE FROM notifications WHERE id = ? AND user_id = ?`)
    .run(id, userId);
  return info.changes > 0;
}
