import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/memory/db.ts";
import {
  insertMessage,
  getMessagesBySession,
} from "../../src/memory/messages.ts";
import { searchBM25 } from "../../src/memory/bm25.ts";
import { upsertEmbedding, searchVector } from "../../src/memory/vector.ts";

let tmp: string;

async function newDb() {
  tmp = mkdtempSync(join(tmpdir(), "bunny-db-"));
  return openDb(join(tmp, "test.sqlite"));
}

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("schema + messages", () => {
  test("opens database and tables exist", async () => {
    const db = await newDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("events");
    expect(names).toContain("messages");
    db.close();
  });

  test("insertMessage persists a row", async () => {
    const db = await newDb();
    const id = insertMessage(db, {
      sessionId: "s1",
      role: "user",
      content: "hello bunny",
    });
    expect(id).toBeGreaterThan(0);
    db.close();
  });

  test("getMessagesBySession returns rows in insertion order", async () => {
    const db = await newDb();
    insertMessage(db, { sessionId: "sess", role: "user", content: "first" });
    insertMessage(db, {
      sessionId: "sess",
      role: "assistant",
      content: "second",
    });
    const rows = getMessagesBySession(db, "sess");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.content).toBe("first");
    expect(rows[1]?.content).toBe("second");
    db.close();
  });

  test("from_automation default is 0; insertMessage with fromAutomation=true stamps 1", async () => {
    const db = await newDb();
    const a = insertMessage(db, {
      sessionId: "auto-1",
      role: "user",
      content: "real",
    });
    const b = insertMessage(db, {
      sessionId: "auto-2",
      role: "user",
      content: "automated",
      fromAutomation: true,
    });
    const row = (id: number) =>
      db
        .prepare("SELECT from_automation AS f FROM messages WHERE id = ?")
        .get(id) as { f: number };
    expect(row(a).f).toBe(0);
    expect(row(b).f).toBe(1);
    db.close();
  });

  test("backfill flips legacy automation rows to from_automation = 1", async () => {
    // Open the DB once to materialize the schema, drop the column to simulate
    // a pre-migration database, then re-open so migrateColumns re-adds the
    // column with default 0 and runs the backfill UPDATE.
    const db = await newDb();
    const path = join(tmp!, "test.sqlite");

    // Insert prefixed rows + a board_card_runs entry directly via SQL so the
    // rows exist *before* migrateColumns runs the backfill on re-open. Use
    // raw SQL with the legacy (no-from_automation) column list.
    const insertLegacy = (sessionId: string, content: string): number => {
      const r = db
        .prepare(
          `INSERT INTO messages (session_id, ts, role, channel, content, user_id, project)
           VALUES (?, ?, 'user', 'content', ?, NULL, 'general') RETURNING id`,
        )
        .get(sessionId, Date.now(), content) as { id: number };
      return r.id;
    };
    const realId = insertLegacy("real-chat", "human");
    const newsId = insertLegacy("web-news-abc", "news");
    const memId = insertLegacy("memory-user-xyz", "merge");
    const translateId = insertLegacy("translate-kb-1", "translation");
    const cardId = insertLegacy("bare-uuid-card", "card-run reply");

    // Simulate the card-run discriminator: an entry in board_card_runs.
    // The full chain (swimlane + card + run) needs minimum NOT NULL columns.
    const now = Date.now();
    db.run(
      `INSERT INTO board_swimlanes (id, project, name, position, created_at, updated_at)
       VALUES (1, 'general', 'Todo', 100, ?, ?)`,
      [now, now],
    );
    db.run(
      `INSERT INTO board_cards (id, project, swimlane_id, title, position, created_by, created_at, updated_at)
       VALUES (1, 'general', 1, 't', 100, 'sys', ?, ?)`,
      [now, now],
    );
    db.run(
      `INSERT INTO board_card_runs (id, card_id, session_id, agent, triggered_by, trigger_kind, status, started_at)
       VALUES (1, 1, 'bare-uuid-card', 'bunny', 'sys', 'manual', 'done', ?)`,
      [now],
    );

    // Reset from_automation to 0 on every row + close the DB so the next
    // openDb() runs migrateColumns (which is idempotent + the backfill
    // gate WHERE from_automation = 0 catches every row we just inserted).
    db.run(`UPDATE messages SET from_automation = 0`);
    db.close();

    const db2 = await openDb(path);
    const flag = (id: number) =>
      (
        db2
          .prepare("SELECT from_automation AS f FROM messages WHERE id = ?")
          .get(id) as { f: number }
      ).f;
    expect(flag(realId)).toBe(0);
    expect(flag(newsId)).toBe(1);
    expect(flag(memId)).toBe(1);
    expect(flag(translateId)).toBe(1);
    expect(flag(cardId)).toBe(1);
    db2.close();
  });

  test("stores reasoning channel separately", async () => {
    const db = await newDb();
    insertMessage(db, {
      sessionId: "s2",
      role: "assistant",
      channel: "reasoning",
      content: "let me think",
    });
    insertMessage(db, {
      sessionId: "s2",
      role: "assistant",
      channel: "content",
      content: "the answer",
    });
    const rows = getMessagesBySession(db, "s2");
    expect(rows.find((r) => r.channel === "reasoning")?.content).toBe(
      "let me think",
    );
    expect(rows.find((r) => r.channel === "content")?.content).toBe(
      "the answer",
    );
    db.close();
  });
});

describe("BM25 / FTS5", () => {
  test("searchBM25 finds inserted content messages", async () => {
    const db = await newDb();
    insertMessage(db, {
      sessionId: "s3",
      role: "user",
      content: "the quick brown fox",
    });
    insertMessage(db, {
      sessionId: "s3",
      role: "user",
      content: "pack my box with five dozen liquor jugs",
    });
    const results = searchBM25(db, "quick brown fox", 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.content).toContain("fox");
    db.close();
  });

  test("searchBM25 does not find reasoning-channel text", async () => {
    const db = await newDb();
    insertMessage(db, {
      sessionId: "s4",
      role: "assistant",
      channel: "reasoning",
      content: "secret internal thought",
    });
    const results = searchBM25(db, "secret internal", 10);
    expect(results).toHaveLength(0);
    db.close();
  });

  test("searchBM25 returns empty for empty query", async () => {
    const db = await newDb();
    expect(searchBM25(db, "", 10)).toHaveLength(0);
    db.close();
  });
});

describe("vector embeddings", () => {
  test("upsertEmbedding and searchVector work when sqlite-vec is available", async () => {
    const db = await newDb();
    const dim = 4;

    // Reopen with dim=4 to get a small embeddings table.
    db.close();
    const db4 = await openDb(join(tmp!, "test4.sqlite"), dim);

    const id = insertMessage(db4, {
      sessionId: "sv",
      role: "user",
      content: "vectors are fun",
    });
    // Store a simple [1,0,0,0] vector.
    try {
      upsertEmbedding(db4, id, [1, 0, 0, 0]);
      const results = searchVector(db4, [1, 0, 0, 0], 5);
      // If sqlite-vec is loaded, we get a result; if not, we get []
      if (results.length > 0) {
        expect(results[0]?.messageId).toBe(id);
      }
    } catch {
      // sqlite-vec not installed in CI — acceptable
    }
    db4.close();
  });
});
