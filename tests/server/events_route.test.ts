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
  llm: {
    baseUrl: "",
    apiKey: "",
    model: "x",
    modelReasoning: undefined,
    profile: undefined,
    maxConcurrentRequests: 1,
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
  tmp = mkdtempSync(join(tmpdir(), "bunny-events-route-"));
  db = await openDb(join(tmp, "test.sqlite"));
  await ensureSeedUsers(db, cfg.auth);
  ctx = {
    db,
    cfg,
    queue: {
      log: () => {},
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

  db.prepare(
    `INSERT INTO events (ts, topic, kind, session_id, payload_json, duration_ms, error, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(1000, "llm", "request", "s1", '{"q":"hi"}', null, null, "u1");
  db.prepare(
    `INSERT INTO events (ts, topic, kind, session_id, payload_json, duration_ms, error, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(2000, "tool", "result", "s1", null, 5, "boom", "u1");
});

afterEach(() => {
  db.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

async function req(
  method: string,
  path: string,
  opts: { cookie?: string } = {},
): Promise<{ res: Response; body: any }> {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers["Cookie"] = opts.cookie;
  const r = new Request("http://localhost" + path, { method, headers });
  const res = await handleApi(r, new URL(r.url), ctx);
  const body = await res.json();
  return { res, body };
}

function extractCookie(res: Response): string {
  const setCookie = res.headers.get("set-cookie") ?? "";
  const match = setCookie.match(/bunny_session=([^;]+)/);
  if (!match) throw new Error("no cookie");
  return `bunny_session=${match[1]}`;
}

async function login(username: string, password: string): Promise<string> {
  const r = await new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const res = await handleApi(r, new URL(r.url), ctx);
  return extractCookie(res);
}

describe("events routes", () => {
  test("unauthenticated → 401", async () => {
    const r = await req("GET", "/api/events");
    expect(r.res.status).toBe(401);
  });

  test("non-admin → 403", async () => {
    await createUser(db, { username: "bob", password: "pw-bob" });
    const cookie = await login("bob", "pw-bob");
    const r = await req("GET", "/api/events", { cookie });
    expect(r.res.status).toBe(403);
  });

  test("admin gets paginated list with total", async () => {
    const cookie = await login("admin", "pw-initial");
    const r = await req("GET", "/api/events", { cookie });
    expect(r.res.status).toBe(200);
    expect(r.body.total).toBe(2);
    const items = r.body.items as Array<{ ts: number }>;
    expect(items.map((i) => i.ts)).toEqual([2000, 1000]);
  });

  test("admin filter errors_only=1", async () => {
    const cookie = await login("admin", "pw-initial");
    const r = await req("GET", "/api/events?errors_only=1", { cookie });
    expect(r.res.status).toBe(200);
    expect(r.body.total).toBe(1);
    expect((r.body.items as Array<{ error: string }>)[0]!.error).toBe("boom");
  });

  test("admin filter topic + date range", async () => {
    const cookie = await login("admin", "pw-initial");
    const r = await req("GET", "/api/events?topic=llm&from=500&to=1500", {
      cookie,
    });
    expect(r.body.total).toBe(1);
    expect((r.body.items as Array<{ topic: string }>)[0]!.topic).toBe("llm");
  });

  test("admin facets endpoint", async () => {
    const cookie = await login("admin", "pw-initial");
    const r = await req("GET", "/api/events/facets", { cookie });
    expect(r.res.status).toBe(200);
    expect(r.body.topics).toEqual(["llm", "tool"]);
    expect(r.body.kinds).toEqual(["request", "result"]);
  });

  test("non-admin facets → 403", async () => {
    await createUser(db, { username: "eve", password: "pw-eve" });
    const cookie = await login("eve", "pw-eve");
    const r = await req("GET", "/api/events/facets", { cookie });
    expect(r.res.status).toBe(403);
  });
});
