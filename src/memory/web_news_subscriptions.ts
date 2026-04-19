/**
 * Per-topic Telegram subscribers for Web News digests.
 *
 * When a Web News topic completes a successful run, the outbound hook fans
 * the digest out to every user listed here. If no explicit rows exist for a
 * topic, the hook falls back to the topic creator only — that keeps "noisy"
 * topics opt-in rather than auto-broadcast.
 *
 * The table is tiny and cheap; there is no separate "unsubscribe all" UI —
 * callers either list/upsert/delete.
 *
 * See ADR 0028.
 */

import type { Database } from "bun:sqlite";

export interface TopicSubscription {
  topicId: number;
  userId: string;
  createdAt: number;
}

interface SubRow {
  topic_id: number;
  user_id: string;
  created_at: number;
}

function rowToSub(r: SubRow): TopicSubscription {
  return {
    topicId: r.topic_id,
    userId: r.user_id,
    createdAt: r.created_at,
  };
}

export function listTopicSubscribers(
  db: Database,
  topicId: number,
): TopicSubscription[] {
  const rows = db
    .prepare(
      `SELECT topic_id, user_id, created_at
         FROM web_news_topic_subscriptions
        WHERE topic_id = ? ORDER BY created_at ASC`,
    )
    .all(topicId) as SubRow[];
  return rows.map(rowToSub);
}

export function addTopicSubscriber(
  db: Database,
  topicId: number,
  userId: string,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO web_news_topic_subscriptions(topic_id, user_id, created_at)
     VALUES (?, ?, ?)`,
  ).run(topicId, userId, Date.now());
}

export function removeTopicSubscriber(
  db: Database,
  topicId: number,
  userId: string,
): void {
  db.prepare(
    `DELETE FROM web_news_topic_subscriptions WHERE topic_id = ? AND user_id = ?`,
  ).run(topicId, userId);
}

export function setTopicSubscribers(
  db: Database,
  topicId: number,
  userIds: string[],
): void {
  const tx = db.transaction(() => {
    db.prepare(
      `DELETE FROM web_news_topic_subscriptions WHERE topic_id = ?`,
    ).run(topicId);
    const now = Date.now();
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO web_news_topic_subscriptions(topic_id, user_id, created_at)
       VALUES (?, ?, ?)`,
    );
    for (const uid of userIds) stmt.run(topicId, uid, now);
  });
  tx();
}
