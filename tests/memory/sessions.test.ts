import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/memory/db.ts";
import { insertMessage } from "../../src/memory/messages.ts";
import { listSessions } from "../../src/memory/sessions.ts";

let tmp: string;

async function newDb() {
  tmp = mkdtempSync(join(tmpdir(), "bunny-sessions-"));
  return openDb(join(tmp, "test.sqlite"));
}

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

async function seed() {
  const db = await newDb();
  insertMessage(db, { sessionId: "s1", role: "user", content: "hello about cats" });
  insertMessage(db, { sessionId: "s1", role: "assistant", content: "meow" });
  insertMessage(db, { sessionId: "s2", role: "user", content: "hello about dogs" });
  insertMessage(db, { sessionId: "s2", role: "assistant", content: "woof" });
  return db;
}

describe("listSessions", () => {
  test("groups messages per session and returns summary", async () => {
    const db = await seed();
    const sessions = listSessions(db);
    expect(sessions.map((s) => s.sessionId).sort()).toEqual(["s1", "s2"]);
    const s1 = sessions.find((s) => s.sessionId === "s1")!;
    expect(s1.messageCount).toBe(2);
    expect(s1.title).toContain("cats");
    db.close();
  });

  test("orders by most-recent activity first", async () => {
    const db = await seed();
    // Bump s1 with a later message.
    insertMessage(db, { sessionId: "s1", role: "user", content: "follow-up" });
    const sessions = listSessions(db);
    expect(sessions[0]!.sessionId).toBe("s1");
    db.close();
  });

  test("search filters to sessions containing the term", async () => {
    const db = await seed();
    const hits = listSessions(db, { search: "dogs" });
    expect(hits.map((s) => s.sessionId)).toEqual(["s2"]);
    db.close();
  });

  test("search returns empty when no messages match", async () => {
    const db = await seed();
    const hits = listSessions(db, { search: "zzqqxyz" });
    expect(hits).toEqual([]);
    db.close();
  });

  test("empty database returns empty array", async () => {
    const db = await newDb();
    expect(listSessions(db)).toEqual([]);
    db.close();
  });
});
