import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../../src/memory/db.ts";
import {
  getMessagesBySession,
  insertMessage,
  trimSessionAfter,
} from "../../src/memory/messages.ts";
import { forkSession, listSessions } from "../../src/memory/sessions.ts";
import { createUser } from "../../src/auth/users.ts";

let tmp: string;

async function newDb() {
  tmp = mkdtempSync(join(tmpdir(), "bunny-fork-"));
  return openDb(join(tmp, "test.sqlite"));
}

async function newUser(db: Database, name: string): Promise<string> {
  return (await createUser(db, { username: name, password: "x", role: "user" }))
    .id;
}

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("forkSession", () => {
  test("copies every non-trimmed message and stamps the new owner", async () => {
    const db = await newDb();
    const owner = await newUser(db, "alice");

    insertMessage(db, {
      sessionId: "src",
      role: "user",
      userId: "src-owner",
      content: "Q1",
    });
    insertMessage(db, {
      sessionId: "src",
      role: "assistant",
      userId: "src-owner",
      content: "A1",
    });

    const { sessionId: dst, copiedCount } = forkSession(db, "src", {
      userId: owner,
      asQuickChat: true,
    });
    expect(copiedCount).toBe(2);
    expect(dst).not.toBe("src");

    const newRows = getMessagesBySession(db, dst);
    expect(newRows.map((r) => r.content)).toEqual(["Q1", "A1"]);
    // New owner stamped onto every copied row.
    expect(newRows.every((r) => r.userId === owner)).toBe(true);
    // Source untouched.
    const srcRows = getMessagesBySession(db, "src");
    expect(srcRows.every((r) => r.userId === "src-owner")).toBe(true);
    db.close();
  });

  test("respects untilMessageId by stopping at the pivot (inclusive)", async () => {
    const db = await newDb();
    const owner = await newUser(db, "bob");

    insertMessage(db, { sessionId: "src", role: "user", content: "1" });
    const pivot = insertMessage(db, {
      sessionId: "src",
      role: "assistant",
      content: "2",
    });
    insertMessage(db, { sessionId: "src", role: "user", content: "3" });
    insertMessage(db, { sessionId: "src", role: "assistant", content: "4" });

    const { sessionId: dst } = forkSession(db, "src", {
      userId: owner,
      untilMessageId: pivot,
    });
    const rows = getMessagesBySession(db, dst);
    expect(rows.map((r) => r.content)).toEqual(["1", "2"]);
    db.close();
  });

  test("trimmed source rows are NOT copied", async () => {
    const db = await newDb();
    const owner = await newUser(db, "carol");

    const keep = insertMessage(db, {
      sessionId: "src",
      role: "user",
      content: "keep",
    });
    insertMessage(db, { sessionId: "src", role: "assistant", content: "drop" });
    trimSessionAfter(db, "src", keep);

    const { sessionId: dst } = forkSession(db, "src", { userId: owner });
    expect(getMessagesBySession(db, dst).map((r) => r.content)).toEqual([
      "keep",
    ]);
    db.close();
  });

  test("editLastMessageContent rewrites the fork's last row only — source is untouched", async () => {
    const db = await newDb();
    const owner = await newUser(db, "eve");

    const u1 = insertMessage(db, {
      sessionId: "src",
      role: "user",
      content: "original",
    });

    const { sessionId: dst } = forkSession(db, "src", {
      userId: owner,
      untilMessageId: u1,
      editLastMessageContent: "edited in fork",
    });

    expect(getMessagesBySession(db, "src").map((r) => r.content)).toEqual([
      "original",
    ]);
    expect(getMessagesBySession(db, dst).map((r) => r.content)).toEqual([
      "edited in fork",
    ]);
    db.close();
  });

  test("flips the quick-chat flag on the new session for the forking user", async () => {
    const db = await newDb();
    const owner = await newUser(db, "dan");

    insertMessage(db, { sessionId: "src", role: "user", content: "hi" });
    const { sessionId: dst } = forkSession(db, "src", {
      userId: owner,
      asQuickChat: true,
    });

    const sessions = listSessions(db, { userId: owner, viewerId: owner });
    const me = sessions.find((s) => s.sessionId === dst);
    expect(me?.isQuickChat).toBe(true);
    expect(me?.forkedFromSessionId).toBe("src");
    db.close();
  });
});
