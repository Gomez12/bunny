import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/memory/db.ts";
import { createProject } from "../../src/memory/projects.ts";
import {
  dispatchMentionNotifications,
  parseUserMentions,
} from "../../src/notifications/mentions.ts";
import type { BunnyQueue } from "../../src/queue/bunqueue.ts";
import { getUserById, type User } from "../../src/auth/users.ts";
import { listForUser } from "../../src/memory/notifications.ts";

let tmp: string;

function makeQueue(): BunnyQueue {
  return {
    async log() {
      /* no-op */
    },
    async close() {
      /* no-op */
    },
  };
}

function seedUser(
  db: Awaited<ReturnType<typeof openDb>>,
  id: string,
  username: string,
  role: "admin" | "user" = "user",
  displayName: string | null = null,
) {
  const now = Date.now();
  db.run(
    `INSERT INTO users(id, username, password_hash, role, display_name, created_at, updated_at)
     VALUES (?, ?, 'x', ?, ?, ?, ?)`,
    [id, username, role, displayName, now, now],
  );
}

async function setup() {
  tmp = mkdtempSync(join(tmpdir(), "bunny-mentions-"));
  const db = await openDb(join(tmp, "test.sqlite"));
  seedUser(db, "u_alice", "alice", "user", "Alice");
  seedUser(db, "u_bob", "bob", "user", "Bob");
  seedUser(db, "u_carol", "carol", "user", "Carol");
  createProject(db, {
    name: "pub",
    createdBy: "u_alice",
    visibility: "public",
  });
  createProject(db, {
    name: "priv",
    createdBy: "u_alice",
    visibility: "private",
  });
  return { db };
}

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("parseUserMentions", () => {
  test("matches start/middle/end, dedupes, preserves first-appearance order", () => {
    expect(parseUserMentions("@alice @bob hi")).toEqual(["alice", "bob"]);
    expect(parseUserMentions("hi @bob how are you @alice")).toEqual([
      "bob",
      "alice",
    ]);
    expect(parseUserMentions("end mention @carol")).toEqual(["carol"]);
    expect(parseUserMentions("@alice @alice @Alice")).toEqual(["alice"]);
  });

  test("skips mentions inside fenced code blocks and inline spans", () => {
    expect(parseUserMentions("see ```\n@alice inside\n```")).toEqual([]);
    expect(parseUserMentions("maybe `@alice` here")).toEqual([]);
    expect(parseUserMentions("real @alice plus `@bob` span")).toEqual([
      "alice",
    ]);
  });

  test("skips emails and URL-like tokens", () => {
    expect(parseUserMentions("mail foo@alice.com now")).toEqual([]);
    expect(parseUserMentions("see https://x.com/@alice and gone")).toEqual([]);
    expect(parseUserMentions("cc:@alice note")).toEqual([]); // ':' precedes @
    expect(parseUserMentions("path/@alice nope")).toEqual([]); // '/' precedes @
  });

  test("case-insensitive results are lowercased", () => {
    expect(parseUserMentions("hi @ALICE")).toEqual(["alice"]);
  });

  test("invalid bodies don't produce matches", () => {
    expect(parseUserMentions("@ not a name")).toEqual([]);
    expect(parseUserMentions("@-bad")).toEqual([]);
    expect(parseUserMentions("@A-very-long-".padEnd(90, "x"))).toEqual([]);
  });

  test("handles punctuation and line breaks around mentions", () => {
    expect(parseUserMentions("hi @alice!")).toEqual(["alice"]);
    expect(parseUserMentions("line one\n@bob line two")).toEqual(["bob"]);
    expect(parseUserMentions("(@carol) parenthesised")).toEqual(["carol"]);
  });

  test("returns [] for empty or non-string inputs", () => {
    expect(parseUserMentions("")).toEqual([]);
    // @ts-expect-error runtime resilience
    expect(parseUserMentions(null)).toEqual([]);
  });
});

describe("dispatchMentionNotifications", () => {
  async function ctx() {
    const { db } = await setup();
    const sender = getUserById(db, "u_bob") as User;
    const queue = makeQueue();
    return { db, sender, queue };
  }

  test("creates one mention per distinct recipient, never for self", async () => {
    const { db, sender, queue } = await ctx();
    const result = dispatchMentionNotifications({
      db,
      queue,
      project: "pub",
      sessionId: "s1",
      messageId: 10,
      sender,
      rawPrompt: "@alice and @carol and @bob hello",
    });
    expect(result.deliveredTo.sort()).toEqual(["u_alice", "u_carol"]);
    expect(result.blockedUsernames).toEqual([]);
    expect(listForUser(db, "u_alice")).toHaveLength(1);
    expect(listForUser(db, "u_carol")).toHaveLength(1);
    expect(listForUser(db, "u_bob")).toHaveLength(0);
  });

  test("unknown username is dropped silently", async () => {
    const { db, sender, queue } = await ctx();
    const result = dispatchMentionNotifications({
      db,
      queue,
      project: "pub",
      sessionId: "s1",
      messageId: 10,
      sender,
      rawPrompt: "hey @ghost nobody home",
    });
    expect(result.unknownUsernames).toEqual(["ghost"]);
    expect(result.deliveredTo).toEqual([]);
  });

  test("private project the recipient can't see: silent skip + one aggregated counter-row for sender", async () => {
    const { db, sender, queue } = await ctx();
    // bob (sender) mentions alice (project creator, can see) and carol (cannot)
    const result = dispatchMentionNotifications({
      db,
      queue,
      project: "priv",
      sessionId: "s2",
      messageId: 11,
      sender,
      rawPrompt: "@alice @carol secret",
    });
    expect(result.deliveredTo).toEqual(["u_alice"]);
    expect(result.blockedUsernames).toEqual(["carol"]);
    const aliceRows = listForUser(db, "u_alice");
    expect(aliceRows).toHaveLength(1);
    expect(aliceRows[0]!.kind).toBe("mention");
    const bobRows = listForUser(db, "u_bob");
    expect(bobRows).toHaveLength(1);
    expect(bobRows[0]!.kind).toBe("mention_blocked");
    expect(bobRows[0]!.body).toContain("@carol");
    const carolRows = listForUser(db, "u_carol");
    expect(carolRows).toHaveLength(0);
  });

  test("multiple blocked recipients coalesce into a single counter-row", async () => {
    const { db, sender, queue } = await ctx();
    // A private project owned by someone who is neither alice nor carol nor
    // bob: alice and carol both lack access. Bob (sender) also lacks it, but
    // handleChat would have blocked that before we got here — the dispatcher
    // itself doesn't check the sender.
    seedUser(db, "u_owner", "ownerx", "user");
    createProject(db, {
      name: "admin_only",
      createdBy: "u_owner",
      visibility: "private",
    });
    const result = dispatchMentionNotifications({
      db,
      queue,
      project: "admin_only",
      sessionId: "s3",
      messageId: 12,
      sender,
      rawPrompt: "@alice @carol",
    });
    expect(result.blockedUsernames.sort()).toEqual(["alice", "carol"]);
    const bobRows = listForUser(db, "u_bob");
    expect(bobRows).toHaveLength(1);
    expect(bobRows[0]!.kind).toBe("mention_blocked");
    expect(bobRows[0]!.body).toContain("@alice");
    expect(bobRows[0]!.body).toContain("@carol");
  });

  test("publish callback fires per created row", async () => {
    const { db, sender, queue } = await ctx();
    const events: Array<[string, string, number]> = [];
    dispatchMentionNotifications({
      db,
      queue,
      project: "pub",
      sessionId: "s4",
      messageId: 13,
      sender,
      rawPrompt: "@alice hi",
      deps: {
        publish: (userId, notif) => events.push([userId, notif.kind, notif.id]),
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]![0]).toBe("u_alice");
    expect(events[0]![1]).toBe("mention");
    expect(events[0]![2]).toBeGreaterThan(0);
  });

  test("deep link encodes project + session and targets the message anchor", async () => {
    const { db, sender, queue } = await ctx();
    dispatchMentionNotifications({
      db,
      queue,
      project: "pub",
      sessionId: "sess-with-dash",
      messageId: 77,
      sender,
      rawPrompt: "@alice",
    });
    const row = listForUser(db, "u_alice")[0]!;
    expect(row.deepLink).toBe(
      "?tab=chat&project=pub&session=sess-with-dash#m77",
    );
  });
});
