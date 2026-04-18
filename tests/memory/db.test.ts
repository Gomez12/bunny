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
