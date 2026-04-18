import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/memory/db.ts";
import { insertMessage } from "../../src/memory/messages.ts";
import { listSessions } from "../../src/memory/sessions.ts";
import { setSessionHiddenFromChat } from "../../src/memory/session_visibility.ts";
import { createUser } from "../../src/auth/users.ts";

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
  insertMessage(db, {
    sessionId: "s1",
    role: "user",
    content: "hello about cats",
  });
  insertMessage(db, { sessionId: "s1", role: "assistant", content: "meow" });
  insertMessage(db, {
    sessionId: "s2",
    role: "user",
    content: "hello about dogs",
  });
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

  test("per-viewer hiddenFromChat flag + excludeHidden filter", async () => {
    const db = await seed();
    const alice = await createUser(db, {
      username: "alice",
      password: "pw-alice",
    });
    const bob = await createUser(db, { username: "bob", password: "pw-bob" });

    // Alice hides s1; Bob hides nothing.
    setSessionHiddenFromChat(db, alice.id, "s1", true);

    // Alice's view: flag set on s1, both still listed.
    const aliceAll = listSessions(db, { viewerId: alice.id });
    expect(aliceAll.find((s) => s.sessionId === "s1")!.hiddenFromChat).toBe(
      true,
    );
    expect(aliceAll.find((s) => s.sessionId === "s2")!.hiddenFromChat).toBe(
      false,
    );

    // Alice's chat view (excludeHidden): s1 dropped.
    const aliceChat = listSessions(db, {
      viewerId: alice.id,
      excludeHidden: true,
    });
    expect(aliceChat.map((s) => s.sessionId).sort()).toEqual(["s2"]);

    // Bob still sees both, both unhidden — visibility is per-user.
    const bobChat = listSessions(db, { viewerId: bob.id, excludeHidden: true });
    expect(bobChat.map((s) => s.sessionId).sort()).toEqual(["s1", "s2"]);
    expect(bobChat.every((s) => !s.hiddenFromChat)).toBe(true);

    // No viewerId → flag always false (legacy callers).
    expect(listSessions(db).every((s) => !s.hiddenFromChat)).toBe(true);

    // Unhide flips it back.
    setSessionHiddenFromChat(db, alice.id, "s1", false);
    const aliceChatAgain = listSessions(db, {
      viewerId: alice.id,
      excludeHidden: true,
    });
    expect(aliceChatAgain.map((s) => s.sessionId).sort()).toEqual(["s1", "s2"]);

    db.close();
  });
});
