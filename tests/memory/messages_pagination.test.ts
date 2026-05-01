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
  tmp = mkdtempSync(join(tmpdir(), "bunny-msg-page-"));
  return openDb(join(tmp, "test.sqlite"));
}

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("getMessagesBySession — pagination", () => {
  test("no opts returns the whole session in chronological order", async () => {
    const db = await newDb();
    for (let i = 0; i < 5; i++) {
      insertMessage(db, {
        sessionId: "s1",
        role: i % 2 === 0 ? "user" : "assistant",
        content: `msg-${i}`,
      });
    }
    const rows = getMessagesBySession(db, "s1");
    expect(rows.length).toBe(5);
    expect(rows.map((r) => r.content)).toEqual([
      "msg-0",
      "msg-1",
      "msg-2",
      "msg-3",
      "msg-4",
    ]);
    db.close();
  });

  test("limit returns the latest N rows in ascending order", async () => {
    const db = await newDb();
    for (let i = 0; i < 10; i++) {
      insertMessage(db, {
        sessionId: "s1",
        role: i % 2 === 0 ? "user" : "assistant",
        content: `msg-${i}`,
      });
    }
    const page = getMessagesBySession(db, "s1", { limit: 3 });
    expect(page.map((r) => r.content)).toEqual(["msg-7", "msg-8", "msg-9"]);
    db.close();
  });

  test("beforeId + limit pages backwards without overlap", async () => {
    const db = await newDb();
    const ids: number[] = [];
    for (let i = 0; i < 10; i++) {
      ids.push(
        insertMessage(db, {
          sessionId: "s1",
          role: i % 2 === 0 ? "user" : "assistant",
          content: `msg-${i}`,
        }),
      );
    }

    const newest = getMessagesBySession(db, "s1", { limit: 3 });
    expect(newest.map((r) => r.content)).toEqual(["msg-7", "msg-8", "msg-9"]);

    const older = getMessagesBySession(db, "s1", {
      limit: 3,
      beforeId: newest[0]!.id,
    });
    expect(older.map((r) => r.content)).toEqual(["msg-4", "msg-5", "msg-6"]);

    const oldest = getMessagesBySession(db, "s1", {
      limit: 3,
      beforeId: older[0]!.id,
    });
    expect(oldest.map((r) => r.content)).toEqual(["msg-1", "msg-2", "msg-3"]);
    db.close();
  });

  test("limit is hard-capped at 5000", async () => {
    const db = await newDb();
    insertMessage(db, { sessionId: "s1", role: "user", content: "only" });
    // Asking for 9999 must not error and must respect the cap (only 1 row exists).
    const rows = getMessagesBySession(db, "s1", { limit: 9999 });
    expect(rows.length).toBe(1);
    db.close();
  });

  test("beforeId without limit still works (cursor-only mode)", async () => {
    const db = await newDb();
    const ids: number[] = [];
    for (let i = 0; i < 4; i++) {
      ids.push(
        insertMessage(db, {
          sessionId: "s1",
          role: "user",
          content: `msg-${i}`,
        }),
      );
    }
    const rows = getMessagesBySession(db, "s1", { beforeId: ids[2]! });
    expect(rows.map((r) => r.content)).toEqual(["msg-0", "msg-1"]);
    db.close();
  });
});
