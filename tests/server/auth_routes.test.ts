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

let tmp: string;
let db: Database;
let ctx: RouteCtx;

const cfg: BunnyConfig = {
  llm: { baseUrl: "", apiKey: "", model: "x", modelReasoning: undefined, profile: undefined },
  embed: { baseUrl: "", apiKey: "", model: "x", dim: 1536 },
  memory: { indexReasoning: false, recallK: 8, lastN: 10 },
  render: { reasoning: "collapsed", color: undefined },
  queue: { topics: [] },
  auth: { defaultAdminUsername: "admin", defaultAdminPassword: "pw-initial", sessionTtlHours: 1 },
  agent: { systemPrompt: "You are Bunny.", defaultProject: "general" },
  sessionId: undefined,
};

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "bunny-routes-"));
  db = await openDb(join(tmp, "test.sqlite"));
  await ensureSeedUsers(db, cfg.auth);
  ctx = { db, cfg, queue: { log: () => {}, close: async () => {} } as unknown as RouteCtx["queue"] };
});

afterEach(() => {
  db.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

async function req(method: string, path: string, opts: { body?: unknown; cookie?: string; bearer?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.body) headers["Content-Type"] = "application/json";
  if (opts.cookie) headers["Cookie"] = opts.cookie;
  if (opts.bearer) headers["Authorization"] = `Bearer ${opts.bearer}`;
  const r = new Request("http://localhost" + path, {
    method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const res = await handleApi(r, new URL(r.url), ctx);
  const ct = res.headers.get("content-type") ?? "";
  const body = ct.includes("application/json") ? await res.json() : await res.text();
  return { res, body };
}

function extractCookie(res: Response): string | undefined {
  const setCookie = res.headers.get("set-cookie") ?? "";
  const match = setCookie.match(/bunny_session=([^;]+)/);
  return match ? `bunny_session=${match[1]}` : undefined;
}

describe("auth routes", () => {
  test("unauthenticated /api/sessions returns 401", async () => {
    const { res } = await req("GET", "/api/sessions");
    expect(res.status).toBe(401);
  });

  test("login sets cookie, me returns user, logout clears cookie", async () => {
    const login = await req("POST", "/api/auth/login", {
      body: { username: "admin", password: "pw-initial" },
    });
    expect(login.res.status).toBe(200);
    const cookie = extractCookie(login.res)!;
    expect(cookie).toBeDefined();

    const me = await req("GET", "/api/auth/me", { cookie });
    expect(me.res.status).toBe(200);
    expect((me.body as { user: { username: string } }).user.username).toBe("admin");

    const out = await req("POST", "/api/auth/logout", { cookie });
    expect(out.res.status).toBe(200);
    // cookie becomes invalid after logout
    const me2 = await req("GET", "/api/auth/me", { cookie });
    expect(me2.res.status).toBe(401);
  });

  test("login rejects bad password", async () => {
    const r = await req("POST", "/api/auth/login", {
      body: { username: "admin", password: "wrong" },
    });
    expect(r.res.status).toBe(401);
  });

  test("non-admin cannot list users", async () => {
    await createUser(db, { username: "bob", password: "pw-bob" });
    const login = await req("POST", "/api/auth/login", {
      body: { username: "bob", password: "pw-bob" },
    });
    const cookie = extractCookie(login.res)!;
    const r = await req("GET", "/api/users", { cookie });
    expect(r.res.status).toBe(403);
  });

  test("admin can list + search users", async () => {
    await createUser(db, { username: "bob", password: "pw-bob", email: "bob@x.com" });
    const login = await req("POST", "/api/auth/login", {
      body: { username: "admin", password: "pw-initial" },
    });
    const cookie = extractCookie(login.res)!;

    const all = await req("GET", "/api/users", { cookie });
    expect(all.res.status).toBe(200);
    const list = (all.body as { users: { username: string }[] }).users.map((u) => u.username);
    expect(list).toContain("bob");
    expect(list).toContain("admin");

    const search = await req("GET", "/api/users?q=bob", { cookie });
    expect((search.body as { users: unknown[] }).users.length).toBe(1);
  });

  test("api key grants bearer access", async () => {
    await createUser(db, { username: "carol", password: "pw-carol" });
    const login = await req("POST", "/api/auth/login", {
      body: { username: "carol", password: "pw-carol" },
    });
    const cookie = extractCookie(login.res)!;
    const created = await req("POST", "/api/apikeys", {
      cookie,
      body: { name: "cli", ttlDays: 1 },
    });
    expect(created.res.status).toBe(201);
    const key = (created.body as { key: string }).key;

    // Bearer token works without cookie
    const me = await req("GET", "/api/auth/me", { bearer: key });
    expect(me.res.status).toBe(200);
    expect((me.body as { user: { username: string } }).user.username).toBe("carol");
  });
});
