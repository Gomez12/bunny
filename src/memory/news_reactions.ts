import type { Database } from "bun:sqlite";

export type Reaction = "up" | "down";

export interface NewsReaction {
  userId: string;
  itemId: number;
  reaction: Reaction;
  createdAt: number;
}

export interface ReactionSummaryRow {
  title: string;
  source: string | null;
  topicName: string | null;
  reaction: Reaction;
  createdAt: number;
}

export function setReaction(
  db: Database,
  userId: string,
  itemId: number,
  reaction: Reaction,
): void {
  db.prepare(
    `INSERT INTO web_news_item_reactions(user_id, item_id, reaction, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, item_id) DO UPDATE SET reaction = excluded.reaction, created_at = excluded.created_at`,
  ).run(userId, itemId, reaction, Date.now());
}

export function removeReaction(db: Database, userId: string, itemId: number): void {
  db.prepare(
    `DELETE FROM web_news_item_reactions WHERE user_id = ? AND item_id = ?`,
  ).run(userId, itemId);
}

export function getReaction(
  db: Database,
  userId: string,
  itemId: number,
): Reaction | null {
  const row = db
    .prepare(
      `SELECT reaction FROM web_news_item_reactions WHERE user_id = ? AND item_id = ?`,
    )
    .get(userId, itemId) as { reaction: string } | undefined;
  if (!row) return null;
  return row.reaction === "up" ? "up" : "down";
}

/** All reactions for a user scoped to a project, keyed by item_id. */
export function listUserReactionsForProject(
  db: Database,
  userId: string,
  project: string,
): Map<number, Reaction> {
  const rows = db
    .prepare(
      `SELECT r.item_id, r.reaction
         FROM web_news_item_reactions r
         JOIN web_news_items i ON i.id = r.item_id
        WHERE r.user_id = ? AND i.project = ?`,
    )
    .all(userId, project) as Array<{ item_id: number; reaction: string }>;
  const map = new Map<number, Reaction>();
  for (const row of rows) {
    map.set(row.item_id, row.reaction === "up" ? "up" : "down");
  }
  return map;
}

/**
 * Recent reactions with item titles and topic names — used to build the
 * soul-refresh context so the LLM knows what the user likes/dislikes.
 */
export function getReactionsSummary(
  db: Database,
  userId: string,
  limit = 30,
): ReactionSummaryRow[] {
  return db
    .prepare(
      `SELECT i.title, i.source, t.name AS topicName, r.reaction, r.created_at AS createdAt
         FROM web_news_item_reactions r
         JOIN web_news_items i ON i.id = r.item_id
    LEFT JOIN web_news_topics t ON t.id = i.topic_id
        WHERE r.user_id = ?
        ORDER BY r.created_at DESC
        LIMIT ?`,
    )
    .all(userId, limit) as ReactionSummaryRow[];
}
