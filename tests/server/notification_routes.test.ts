import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../../src/memory/db.ts";
import { handleApi, type RouteCtx } from "../../src/server/routes.ts";
import { ensureSeedUsers } from "../../src/auth/seed.ts";
import { createUser } from "../../src/auth/users.ts";
import type { BunnyConfig } from "../../src/config.ts";
import { createNotification } from "../../src/memory/notifications.ts";
import { subscriberCount } from "../../src/notifications/fanout.ts";

let tmp: string;
let db: Database;
let ctx: RouteCtx;

const cfg: BunnyConfig = {
  llm: {
    baseUrl: "",
    apiKey: "",
    model: "x",
    modelReasoning: undefined,
    profile: undefined,
  },
  embed: { baseUrl: "", apiKey: "", model: "x", dim: 1536 },
  memory: { indexReasoning: false, recallK: 8, lastN: 10 },
  render: { reasoning: "collapsed", color: undefined },
  queue: { topics: [] },
  auth: {
    defaultAdminUsername: "admin",
    defaultAdminPassword: "pw-initial",
    sessionTtlHours: 1,
  },
  agent: {
    systemPrompt: "You are Bunny.",
    defaultProject: "general",
    defaultAgent: "bunny",
  },
  ui: { autosaveIntervalMs: 5000 },
  web: {
    serpApiKey: "",
    serpProvider: "serper",
    serpBaseUrl: "",
    userAgent: "",
  },
  translation: {
    maxPerTick: 20,
    maxDocumentBytes: 30_720,
    stuckThresholdMs: 30 * 60 * 1000,
    systemPrompt: "",
  },
  telegram: {
    pollLeaseMs: 50_000,
    chunkChars: 4000,
    documentFallbackBytes: 16 * 1024,
    publicBaseUrl: "",
  },
  code: { cloneTimeoutMs: 300_000, maxRepoSizeMb: 500, defaultCloneDepth: 50, graph: { enabled: true, timeoutMs: 1_800_000, maxFiles: 5000, maxFileSizeKb: 512, maxDocFiles: 100, clusterAlgorithm: "louvain" as const, displayMaxNodes: 300, docExtractionEnabled: false, languages: ["ts","tsx","js","jsx","py","go","rs","java","c","cpp","rb","php"] } },
  workflows: { bashEnabled: false, bashDefaultTimeoutMs: 120_000, bashMaxOutputBytes: 256 * 1024, scriptEnabled: false, scriptDefaultTimeoutMs: 120_000, scriptMaxOutputBytes: 256 * 1024, loopDefaultMaxIterations: 10 },
  sessionId: undefined,
};

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "bunny-notif-routes-"));
  db = await openDb(join(tmp, "test.sqlite"));
  await ensureSeedUsers(db, cfg.auth);
  await createUser(db, {
    username: "alice",
    password: "pw-alice",
    displayName: "Alice",
  });
  ctx = {
    db,
    cfg,
    queue: {
      log: async () => {},
      close: async () => {},
    } as unknown as RouteCtx["queue"],
    scheduler: {
      stop: () => {},
      tick: async () => {},
      runTask: async () => {},
    },
    handlerRegistry: {
      register: () => {},
      get: () => undefined,
      list: () => [],
      unregister: () => {},
      reset: () => {},
    },
  };
});

afterEach(() => {
  db.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

async function login(
  username: string,
  password: string,
): Promise<{ cookie: string; userId: string }> {
  const r = new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const res = await handleApi(r, new URL(r.url), ctx);
  if (res.status !== 200) throw new Error(`login failed ${res.status}`);
  const setCookie = res.headers.get("set-cookie") ?? "";
  const match = setCookie.match(/bunny_session=([^;]+)/);
  if (!match) throw new Error("no session cookie");
  const me = await handleApi(
    new Request("http://localhost/api/auth/me", {
      headers: { Cookie: `bunny_session=${match[1]}` },
    }),
    new URL("http://localhost/api/auth/me"),
    ctx,
  );
  const meBody = (await me.json()) as { user: { id: string } };
  return { cookie: `bunny_session=${match[1]}`, userId: meBody.user.id };
}

async function request(
  method: string,
  path: string,
  cookie: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = new Request("http://localhost" + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const res = await handleApi(r, new URL(r.url), ctx);
  const ct = res.headers.get("content-type") ?? "";
  const data = ct.includes("application/json")
    ? ((await res.json()) as Record<string, unknown>)
    : {};
  return { status: res.status, body: data };
}

describe("GET /api/notifications", () => {
  test("returns this user's rows + unread count", async () => {
    const { cookie, userId } = await login("alice", "pw-alice");
    createNotification(db, {
      userId,
      kind: "mention",
      title: "one",
    });
    createNotification(db, {
      userId,
      kind: "mention",
      title: "two",
    });
    const { status, body } = await request("GET", "/api/notifications", cookie);
    expect(status).toBe(200);
    expect(body["unreadCount"]).toBe(2);
    const items = body["items"] as Array<{ title: string }>;
    expect(items).toHaveLength(2);
    expect(items[0]!.title).toBe("two"); // newest first
  });

  test("respects unread=1 and limit", async () => {
    const { cookie, userId } = await login("alice", "pw-alice");
    const first = createNotification(db, {
      userId,
      kind: "mention",
      title: "a",
    });
    createNotification(db, { userId, kind: "mention", title: "b" });
    createNotification(db, { userId, kind: "mention", title: "c" });
    // Mark 'a' as read directly
    db.run(`UPDATE notifications SET read_at = ? WHERE id = ?`, [
      Date.now(),
      first.id,
    ]);
    const { body } = await request(
      "GET",
      "/api/notifications?unread=1&limit=1",
      cookie,
    );
    const items = body["items"] as Array<{ title: string }>;
    expect(items).toHaveLength(1);
    expect(body["unreadCount"]).toBe(2);
  });

  test("another user's rows are not visible", async () => {
    await createUser(db, {
      username: "bob",
      password: "pw-bob",
      displayName: "Bob",
    });
    const { cookie: aliceCookie, userId: aliceId } = await login(
      "alice",
      "pw-alice",
    );
    const { cookie: bobCookie } = await login("bob", "pw-bob");
    createNotification(db, {
      userId: aliceId,
      kind: "mention",
      title: "private",
    });
    const { body: bobBody } = await request(
      "GET",
      "/api/notifications",
      bobCookie,
    );
    expect(bobBody["unreadCount"]).toBe(0);
    expect((bobBody["items"] as unknown[]).length).toBe(0);
    // Alice still sees it
    const { body: aliceBody } = await request(
      "GET",
      "/api/notifications",
      aliceCookie,
    );
    expect(aliceBody["unreadCount"]).toBe(1);
  });
});

describe("PATCH /api/notifications/:id/read", () => {
  test("marks read and returns new unread count", async () => {
    const { cookie, userId } = await login("alice", "pw-alice");
    const notif = createNotification(db, {
      userId,
      kind: "mention",
      title: "x",
    });
    const { status, body } = await request(
      "PATCH",
      `/api/notifications/${notif.id}/read`,
      cookie,
    );
    expect(status).toBe(200);
    expect(body["unreadCount"]).toBe(0);
    const row = db
      .prepare(`SELECT read_at FROM notifications WHERE id = ?`)
      .get(notif.id) as { read_at: number | null };
    expect(row.read_at).not.toBeNull();
  });

  test("another user's id → 404", async () => {
    await createUser(db, {
      username: "bob",
      password: "pw-bob",
      displayName: "Bob",
    });
    const { userId: aliceId } = await login("alice", "pw-alice");
    const { cookie: bobCookie } = await login("bob", "pw-bob");
    const notif = createNotification(db, {
      userId: aliceId,
      kind: "mention",
      title: "x",
    });
    const { status } = await request(
      "PATCH",
      `/api/notifications/${notif.id}/read`,
      bobCookie,
    );
    expect(status).toBe(404);
  });
});

describe("POST /api/notifications/mark-all-read", () => {
  test("clears every unread for the user", async () => {
    const { cookie, userId } = await login("alice", "pw-alice");
    createNotification(db, { userId, kind: "mention", title: "a" });
    createNotification(db, { userId, kind: "mention", title: "b" });
    const { status, body } = await request(
      "POST",
      "/api/notifications/mark-all-read",
      cookie,
    );
    expect(status).toBe(200);
    expect(body["unreadCount"]).toBe(0);
  });
});

describe("DELETE /api/notifications/:id", () => {
  test("removes the row when it's the user's", async () => {
    const { cookie, userId } = await login("alice", "pw-alice");
    const notif = createNotification(db, {
      userId,
      kind: "mention",
      title: "x",
    });
    const { status } = await request(
      "DELETE",
      `/api/notifications/${notif.id}`,
      cookie,
    );
    expect(status).toBe(200);
    const row = db
      .prepare(`SELECT id FROM notifications WHERE id = ?`)
      .get(notif.id);
    expect(row).toBeNull();
  });

  test("another user's id → 404, row intact", async () => {
    await createUser(db, {
      username: "bob",
      password: "pw-bob",
      displayName: "Bob",
    });
    const { userId: aliceId } = await login("alice", "pw-alice");
    const { cookie: bobCookie } = await login("bob", "pw-bob");
    const notif = createNotification(db, {
      userId: aliceId,
      kind: "mention",
      title: "x",
    });
    const { status } = await request(
      "DELETE",
      `/api/notifications/${notif.id}`,
      bobCookie,
    );
    expect(status).toBe(404);
    const row = db
      .prepare(`SELECT id FROM notifications WHERE id = ?`)
      .get(notif.id);
    expect(row).not.toBeNull();
  });
});

describe("GET /api/notifications/stream", () => {
  test("attaches a subscriber and drops it on cancel (logout cleanup)", async () => {
    const { cookie, userId } = await login("alice", "pw-alice");
    const r = new Request("http://localhost/api/notifications/stream", {
      headers: { Cookie: cookie },
    });
    const res = await handleApi(r, new URL(r.url), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    // The stream body is lazy — we need to read at least one byte for the
    // `start` callback to fire and register the subscriber.
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value!)).toContain(": open");
    expect(subscriberCount(userId)).toBe(1);
    await reader.cancel();
    // Yield so the `cancel` callback runs.
    await new Promise((r2) => setTimeout(r2, 10));
    expect(subscriberCount(userId)).toBe(0);
  });

  test("logout closes the stream subscriber", async () => {
    const { cookie, userId } = await login("alice", "pw-alice");
    const r = new Request("http://localhost/api/notifications/stream", {
      headers: { Cookie: cookie },
    });
    const res = await handleApi(r, new URL(r.url), ctx);
    const reader = res.body!.getReader();
    await reader.read(); // fire start()
    expect(subscriberCount(userId)).toBe(1);
    const logout = await handleApi(
      new Request("http://localhost/api/auth/logout", {
        method: "POST",
        headers: { Cookie: cookie },
      }),
      new URL("http://localhost/api/auth/logout"),
      ctx,
    );
    expect(logout.status).toBe(200);
    expect(subscriberCount(userId)).toBe(0);
    await reader.cancel().catch(() => {});
  });
});
