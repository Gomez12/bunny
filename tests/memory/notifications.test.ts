import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/memory/db.ts";
import {
  createNotification,
  deleteNotification,
  getNotification,
  getUnreadCount,
  listForUser,
  markAllRead,
  markRead,
  MAX_NOTIFICATIONS_PER_USER,
} from "../../src/memory/notifications.ts";

let tmp: string;

function seedUser(db: ReturnType<typeof openDb> extends Promise<infer T> ? T : never, id: string) {
  const now = Date.now();
  db.run(
    `INSERT INTO users(id, username, password_hash, role, display_name, created_at, updated_at)
     VALUES (?, ?, 'x', 'user', ?, ?, ?)`,
    [id, id, id.toUpperCase(), now, now],
  );
}

async function newDb() {
  tmp = mkdtempSync(join(tmpdir(), "bunny-notifications-"));
  return openDb(join(tmp, "test.sqlite"));
}

async function setup() {
  const db = await newDb();
  seedUser(db, "alice");
  seedUser(db, "bob");
  seedUser(db, "carol");
  return { db };
}

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("createNotification", () => {
  test("persists all fields and returns the hydrated row", async () => {
    const { db } = await setup();
    const notif = createNotification(db, {
      userId: "alice",
      kind: "mention",
      title: "Bob mentioned you",
      body: "hey @alice look",
      actorUserId: "bob",
      actorUsername: "bob",
      actorDisplayName: "BOB",
      project: "alpha",
      sessionId: "s1",
      messageId: 42,
      deepLink: "?tab=chat&session=s1#m42",
    });
    expect(notif.id).toBeGreaterThan(0);
    expect(notif.userId).toBe("alice");
    expect(notif.kind).toBe("mention");
    expect(notif.actorDisplayName).toBe("BOB");
    expect(notif.messageId).toBe(42);
    expect(notif.readAt).toBeNull();
    expect(notif.createdAt).toBeGreaterThan(0);
  });

  test("defaults body to empty string and keeps nullable fields null", async () => {
    const { db } = await setup();
    const notif = createNotification(db, {
      userId: "alice",
      kind: "mention_blocked",
      title: "no delivery",
    });
    expect(notif.body).toBe("");
    expect(notif.actorUserId).toBeNull();
    expect(notif.project).toBeNull();
    expect(notif.sessionId).toBeNull();
    expect(notif.messageId).toBeNull();
    expect(notif.deepLink).toBe("");
  });

  test("prunes to the newest MAX rows per user", async () => {
    const { db } = await setup();
    for (let i = 0; i < MAX_NOTIFICATIONS_PER_USER + 5; i++) {
      createNotification(db, {
        userId: "alice",
        kind: "mention",
        title: `n${i}`,
      });
    }
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?`)
      .get("alice") as { n: number };
    expect(row.n).toBe(MAX_NOTIFICATIONS_PER_USER);
    // Bob unaffected
    expect(getUnreadCount(db, "bob")).toBe(0);
  });
});

describe("listForUser", () => {
  test("newest first, filters by user and unread, respects cursor", async () => {
    const { db } = await setup();
    const a1 = createNotification(db, {
      userId: "alice",
      kind: "mention",
      title: "one",
    });
    const a2 = createNotification(db, {
      userId: "alice",
      kind: "mention",
      title: "two",
    });
    const a3 = createNotification(db, {
      userId: "alice",
      kind: "mention",
      title: "three",
    });
    createNotification(db, { userId: "bob", kind: "mention", title: "for bob" });

    const all = listForUser(db, "alice");
    expect(all.map((n) => n.id)).toEqual([a3.id, a2.id, a1.id]);
    expect(all).toHaveLength(3);

    markRead(db, a2.id, "alice");
    const unread = listForUser(db, "alice", { unreadOnly: true });
    expect(unread.map((n) => n.id)).toEqual([a3.id, a1.id]);

    const before = listForUser(db, "alice", { before: a3.id });
    expect(before.map((n) => n.id)).toEqual([a2.id, a1.id]);
  });
});

describe("getUnreadCount", () => {
  test("excludes read and other users", async () => {
    const { db } = await setup();
    const a1 = createNotification(db, {
      userId: "alice",
      kind: "mention",
      title: "one",
    });
    createNotification(db, { userId: "alice", kind: "mention", title: "two" });
    createNotification(db, { userId: "bob", kind: "mention", title: "three" });
    expect(getUnreadCount(db, "alice")).toBe(2);
    markRead(db, a1.id, "alice");
    expect(getUnreadCount(db, "alice")).toBe(1);
    expect(getUnreadCount(db, "bob")).toBe(1);
  });
});

describe("markRead / markAllRead", () => {
  test("markRead only affects the owning user and unread state", async () => {
    const { db } = await setup();
    const notif = createNotification(db, {
      userId: "alice",
      kind: "mention",
      title: "x",
    });
    expect(markRead(db, notif.id, "bob")).toBeNull(); // not bob's
    expect(markRead(db, notif.id, "alice")).toBeGreaterThan(0);
    expect(markRead(db, notif.id, "alice")).toBeNull(); // already read
    const after = getNotification(db, notif.id);
    expect(after?.readAt).toBeGreaterThan(0);
  });

  test("markAllRead clears every unread for the user", async () => {
    const { db } = await setup();
    createNotification(db, { userId: "alice", kind: "mention", title: "a" });
    createNotification(db, { userId: "alice", kind: "mention", title: "b" });
    createNotification(db, { userId: "bob", kind: "mention", title: "c" });
    markAllRead(db, "alice");
    expect(getUnreadCount(db, "alice")).toBe(0);
    expect(getUnreadCount(db, "bob")).toBe(1);
  });
});

describe("deleteNotification", () => {
  test("only the owner can delete", async () => {
    const { db } = await setup();
    const notif = createNotification(db, {
      userId: "alice",
      kind: "mention",
      title: "x",
    });
    expect(deleteNotification(db, notif.id, "bob")).toBe(false);
    expect(getNotification(db, notif.id)).not.toBeNull();
    expect(deleteNotification(db, notif.id, "alice")).toBe(true);
    expect(getNotification(db, notif.id)).toBeNull();
  });
});

describe("ON DELETE CASCADE", () => {
  test("deleting the recipient user drops their notifications", async () => {
    const { db } = await setup();
    createNotification(db, { userId: "alice", kind: "mention", title: "x" });
    createNotification(db, { userId: "alice", kind: "mention", title: "y" });
    createNotification(db, { userId: "bob", kind: "mention", title: "for bob" });
    db.run(`DELETE FROM users WHERE id = 'alice'`);
    expect(listForUser(db, "alice")).toHaveLength(0);
    expect(listForUser(db, "bob")).toHaveLength(1);
  });

  test("deleting the actor user nulls actor_user_id but keeps the row", async () => {
    const { db } = await setup();
    const notif = createNotification(db, {
      userId: "alice",
      kind: "mention",
      title: "x",
      actorUserId: "bob",
      actorUsername: "bob",
      actorDisplayName: "BOB",
    });
    db.run(`DELETE FROM users WHERE id = 'bob'`);
    const after = getNotification(db, notif.id);
    expect(after).not.toBeNull();
    expect(after!.actorUserId).toBeNull();
    expect(after!.actorUsername).toBe("bob"); // denormalised copy survives
    expect(after!.actorDisplayName).toBe("BOB");
  });
});
