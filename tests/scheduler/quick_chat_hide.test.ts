import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../../src/memory/db.ts";
import { insertMessage } from "../../src/memory/messages.ts";
import {
  setSessionHiddenFromChat,
  setSessionQuickChat,
} from "../../src/memory/session_visibility.ts";
import { createUser } from "../../src/auth/users.ts";
import { selectAndHideInactive } from "../../src/scheduler/handlers/session_quick_chat.ts";

let tmp: string;

async function newDb() {
  tmp = mkdtempSync(join(tmpdir(), "bunny-qc-hide-"));
  return openDb(join(tmp, "test.sqlite"));
}

async function newUser(db: Database, name: string): Promise<string> {
  return (await createUser(db, { username: name, password: "x" })).id;
}

function backdateSession(db: Database, sessionId: string, ts: number): void {
  db.prepare(`UPDATE messages SET ts = ? WHERE session_id = ?`).run(ts, sessionId);
}

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const FIFTEEN_MIN = 15 * 60 * 1000;

describe("session.hide_inactive_quick_chats handler logic", () => {
  test("hides quick chats whose newest message is older than the threshold", async () => {
    const db = await newDb();
    const u = await newUser(db, "alice");
    insertMessage(db, { sessionId: "old", role: "user", userId: u, content: "old message" });
    setSessionQuickChat(db, u, "old", true);
    backdateSession(db, "old", Date.now() - FIFTEEN_MIN - 60_000);

    const hidden = selectAndHideInactive(db, Date.now(), FIFTEEN_MIN);
    expect(hidden.map((h) => h.session_id)).toEqual(["old"]);
    db.close();
  });

  test("does NOT touch quick chats with recent activity", async () => {
    const db = await newDb();
    const u = await newUser(db, "bob");
    insertMessage(db, { sessionId: "fresh", role: "user", userId: u, content: "recent" });
    setSessionQuickChat(db, u, "fresh", true);
    expect(selectAndHideInactive(db, Date.now(), FIFTEEN_MIN)).toEqual([]);
    db.close();
  });

  test("ignores already-hidden rows", async () => {
    const db = await newDb();
    const u = await newUser(db, "carol");
    insertMessage(db, { sessionId: "x", role: "user", userId: u, content: "old" });
    backdateSession(db, "x", Date.now() - FIFTEEN_MIN - 60_000);
    setSessionQuickChat(db, u, "x", true);
    setSessionHiddenFromChat(db, u, "x", true);
    expect(selectAndHideInactive(db, Date.now(), FIFTEEN_MIN)).toEqual([]);
    db.close();
  });

  test("does NOT hide an empty quick chat (no messages yet)", async () => {
    const db = await newDb();
    const u = await newUser(db, "ed");
    setSessionQuickChat(db, u, "empty", true);
    expect(selectAndHideInactive(db, Date.now(), FIFTEEN_MIN)).toEqual([]);
    db.close();
  });

  test("ignores non-quick-chat sessions even if inactive", async () => {
    const db = await newDb();
    const u = await newUser(db, "dan");
    insertMessage(db, { sessionId: "regular", role: "user", userId: u, content: "ages ago" });
    backdateSession(db, "regular", Date.now() - FIFTEEN_MIN - 60_000);
    expect(selectAndHideInactive(db, Date.now(), FIFTEEN_MIN)).toEqual([]);
    db.close();
  });
});
