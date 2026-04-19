import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../../src/memory/db.ts";
import { createProject } from "../../src/memory/projects.ts";
import {
  getLinkByChatId,
  getLinkByUser,
  releaseMutex,
  setCurrentSession,
  tryAcquireMutex,
  upsertLink,
} from "../../src/memory/telegram_links.ts";

let tmp: string;
let db: Database;

function seedUser(db: Database, id: string, username: string) {
  const now = Date.now();
  db.run(
    `INSERT INTO users(id, username, password_hash, role, created_at, updated_at)
     VALUES (?, ?, 'x', 'user', ?, ?)`,
    [id, username, now, now],
  );
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "bunny-tg-links-"));
  db = await openDb(join(tmp, "test.sqlite"));
  seedUser(db, "u_alice", "alice");
  seedUser(db, "u_bob", "bob");
  createProject(db, { name: "alpha", createdBy: null });
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("upsertLink", () => {
  test("creates a fresh link", () => {
    const link = upsertLink(db, {
      userId: "u_alice",
      project: "alpha",
      chatId: 111,
    });
    expect(link.chatId).toBe(111);
    expect(link.busyUntil).toBe(0);
  });

  test("re-pairing the same chat_id to a new user overwrites the old row", () => {
    upsertLink(db, { userId: "u_alice", project: "alpha", chatId: 222 });
    upsertLink(db, { userId: "u_bob", project: "alpha", chatId: 222 });
    // Bob now owns chat 222 in alpha.
    expect(getLinkByChatId(db, "alpha", 222)?.userId).toBe("u_bob");
    expect(getLinkByUser(db, "u_alice", "alpha")).toBeNull();
  });

  test("re-pairing the same user to a new chat updates in place", () => {
    upsertLink(db, { userId: "u_alice", project: "alpha", chatId: 111 });
    upsertLink(db, { userId: "u_alice", project: "alpha", chatId: 333 });
    expect(getLinkByUser(db, "u_alice", "alpha")?.chatId).toBe(333);
    expect(getLinkByChatId(db, "alpha", 111)).toBeNull();
    expect(getLinkByChatId(db, "alpha", 333)?.userId).toBe("u_alice");
  });
});

describe("mutex", () => {
  test("first acquire wins, concurrent acquires lose", () => {
    upsertLink(db, { userId: "u_alice", project: "alpha", chatId: 111 });
    const now = Date.now();
    expect(tryAcquireMutex(db, "alpha", 111, 60_000, now)).toBe(true);
    expect(tryAcquireMutex(db, "alpha", 111, 60_000, now + 100)).toBe(false);
  });

  test("mutex self-expires after ttl", () => {
    upsertLink(db, { userId: "u_alice", project: "alpha", chatId: 111 });
    const now = Date.now();
    tryAcquireMutex(db, "alpha", 111, 1_000, now);
    expect(tryAcquireMutex(db, "alpha", 111, 1_000, now + 1_500)).toBe(true);
  });

  test("release frees the mutex immediately", () => {
    upsertLink(db, { userId: "u_alice", project: "alpha", chatId: 111 });
    const now = Date.now();
    tryAcquireMutex(db, "alpha", 111, 60_000, now);
    releaseMutex(db, "alpha", 111);
    expect(tryAcquireMutex(db, "alpha", 111, 60_000, now + 10)).toBe(true);
  });
});

describe("setCurrentSession", () => {
  test("persists the rolling session and clears it on null", () => {
    upsertLink(db, { userId: "u_alice", project: "alpha", chatId: 111 });
    setCurrentSession(db, "alpha", 111, "sess-1");
    expect(getLinkByChatId(db, "alpha", 111)?.currentSessionId).toBe("sess-1");
    setCurrentSession(db, "alpha", 111, null);
    expect(getLinkByChatId(db, "alpha", 111)?.currentSessionId).toBeNull();
  });
});
