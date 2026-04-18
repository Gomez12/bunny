import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/memory/db.ts";
import {
  getMessagesBySession,
  insertMessage,
} from "../../src/memory/messages.ts";

let tmp: string;

async function newDb() {
  tmp = mkdtempSync(join(tmpdir(), "bunny-regen-chain-"));
  return openDb(join(tmp, "test.sqlite"));
}

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("regen chain assembly via getMessagesBySession", () => {
  test("messages without regenerations have a single-entry chain", async () => {
    const db = await newDb();
    insertMessage(db, { sessionId: "s1", role: "user", content: "Q1" });
    insertMessage(db, { sessionId: "s1", role: "assistant", content: "A1" });
    const rows = getMessagesBySession(db, "s1");
    expect(rows[1]!.regenChain).toHaveLength(1);
    expect(rows[1]!.regenChain[0]!.content).toBe("A1");
    db.close();
  });

  test("multiple regenerations form an ordered chain (root first, latest last)", async () => {
    const db = await newDb();
    insertMessage(db, { sessionId: "s1", role: "user", content: "Q1" });
    const a1 = insertMessage(db, {
      sessionId: "s1",
      role: "assistant",
      content: "A1",
    });
    const a2 = insertMessage(db, {
      sessionId: "s1",
      role: "assistant",
      content: "A2",
      regenOfMessageId: a1,
    });
    const a3 = insertMessage(db, {
      sessionId: "s1",
      role: "assistant",
      content: "A3",
      regenOfMessageId: a2,
    });

    const rows = getMessagesBySession(db, "s1");
    // Every assistant content row sees the same chain.
    for (const id of [a1, a2, a3]) {
      const row = rows.find((r) => r.id === id)!;
      expect(row.regenChain.map((c) => c.id)).toEqual([a1, a2, a3]);
      expect(row.regenChain.map((c) => c.content)).toEqual(["A1", "A2", "A3"]);
    }
    db.close();
  });

  test("regen_of_message_id is stamped onto inserted rows and round-trips", async () => {
    const db = await newDb();
    const root = insertMessage(db, {
      sessionId: "s1",
      role: "assistant",
      content: "root",
    });
    const alt = insertMessage(db, {
      sessionId: "s1",
      role: "assistant",
      content: "alt",
      regenOfMessageId: root,
    });
    const rows = getMessagesBySession(db, "s1");
    expect(rows.find((r) => r.id === alt)!.regenOfMessageId).toBe(root);
    expect(rows.find((r) => r.id === root)!.regenOfMessageId).toBeNull();
    db.close();
  });
});
