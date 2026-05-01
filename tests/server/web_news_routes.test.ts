import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../../src/memory/db.ts";
import { handleApi, type RouteCtx } from "../../src/server/routes.ts";
import { ensureSeedUsers } from "../../src/auth/seed.ts";
import { createUser } from "../../src/auth/users.ts";
import { createProject } from "../../src/memory/projects.ts";
import { createAgent, linkAgentToProject } from "../../src/memory/agents.ts";
import type { BunnyConfig } from "../../src/config.ts";

let tmp: string;
let db: Database;
let ctx: RouteCtx;
let adminCookie: string;
let userCookie: string;
let queueEvents: Array<{ topic: string; kind: string; data?: unknown }> = [];

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
  tmp = mkdtempSync(join(tmpdir(), "bunny-news-routes-"));
  db = await openDb(join(tmp, "test.sqlite"));
  await ensureSeedUsers(db, cfg.auth);
  queueEvents = [];
  ctx = {
    db,
    cfg,
    queue: {
      log: (ev: { topic: string; kind: string; data?: unknown }) => {
        queueEvents.push({ topic: ev.topic, kind: ev.kind, data: ev.data });
      },
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
  adminCookie = await login("admin", "pw-initial");
  await createUser(db, {
    username: "alice",
    password: "pw-alice",
    role: "user",
  });
  userCookie = await login("alice", "pw-alice");
});

afterEach(() => {
  db.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

async function req(
  method: string,
  path: string,
  opts: { body?: unknown; cookie?: string } = {},
) {
  const headers: Record<string, string> = {};
  if (opts.body) headers["Content-Type"] = "application/json";
  if (opts.cookie) headers["Cookie"] = opts.cookie;
  const r = new Request("http://localhost" + path, {
    method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const res = await handleApi(r, new URL(r.url), ctx);
  const ct = res.headers.get("content-type") ?? "";
  const body = ct.includes("application/json")
    ? await res.json()
    : await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { res, body: body as any };
}

async function login(username: string, password: string): Promise<string> {
  const res = await req("POST", "/api/auth/login", {
    body: { username, password },
  });
  const setCookie = res.res.headers.get("set-cookie") ?? "";
  const match = setCookie.match(/bunny_session=([^;]+)/);
  if (!match) throw new Error(`no cookie for ${username}`);
  return `bunny_session=${match[1]}`;
}

async function setupProjectWithAgent() {
  const admin = db
    .prepare(`SELECT id FROM users WHERE username = 'admin'`)
    .get() as { id: string };
  createProject(db, { name: "alpha", createdBy: admin.id });
  createAgent(db, {
    name: "researcher",
    description: "finds news",
    createdBy: admin.id,
  });
  linkAgentToProject(db, "alpha", "researcher");
}

describe("Web News HTTP surface", () => {
  test("create topic logs a queue event and round-trips", async () => {
    await setupProjectWithAgent();
    const create = await req("POST", "/api/projects/alpha/news/topics", {
      body: {
        name: "AI",
        agent: "researcher",
        updateCron: "0 */6 * * *",
      },
      cookie: adminCookie,
    });
    expect(create.res.status).toBe(201);
    expect(create.body.topic.name).toBe("AI");
    expect(create.body.topic.runStatus).toBe("idle");
    expect(
      queueEvents.find(
        (e) => e.topic === "web_news" && e.kind === "topic.create",
      ),
    ).toBeDefined();

    const list = await req("GET", "/api/projects/alpha/news/topics", {
      cookie: adminCookie,
    });
    expect(list.res.status).toBe(200);
    expect(list.body.topics).toHaveLength(1);
  });

  test("non-existent agent → 400", async () => {
    await setupProjectWithAgent();
    const res = await req("POST", "/api/projects/alpha/news/topics", {
      body: { name: "x", agent: "ghost", updateCron: "* * * * *" },
      cookie: adminCookie,
    });
    expect(res.res.status).toBe(400);
  });

  test("malformed cron → 400", async () => {
    await setupProjectWithAgent();
    const res = await req("POST", "/api/projects/alpha/news/topics", {
      body: { name: "x", agent: "researcher", updateCron: "not a cron" },
      cookie: adminCookie,
    });
    expect(res.res.status).toBe(400);
  });

  test("any project viewer can create a topic on a public project", async () => {
    await setupProjectWithAgent();
    const res = await req("POST", "/api/projects/alpha/news/topics", {
      body: {
        name: "Alice's topic",
        agent: "researcher",
        updateCron: "0 */6 * * *",
      },
      cookie: userCookie,
    });
    expect(res.res.status).toBe(201);
    expect(res.body.topic.createdBy).toBeDefined();

    const patch = await req(
      "PATCH",
      `/api/projects/alpha/news/topics/${res.body.topic.id}`,
      { body: { name: "renamed" }, cookie: userCookie },
    );
    expect(patch.res.status).toBe(200);
  });

  test("non-creator, non-owner viewer cannot edit someone else's topic", async () => {
    await setupProjectWithAgent();
    const created = await req("POST", "/api/projects/alpha/news/topics", {
      body: {
        name: "Admin's topic",
        agent: "researcher",
        updateCron: "0 */6 * * *",
      },
      cookie: adminCookie,
    });
    const patch = await req(
      "PATCH",
      `/api/projects/alpha/news/topics/${created.body.topic.id}`,
      { body: { name: "hijacked" }, cookie: userCookie },
    );
    expect(patch.res.status).toBe(403);
  });

  test("non-owner of a private project gets 403 on list", async () => {
    const admin = db
      .prepare(`SELECT id FROM users WHERE username = 'admin'`)
      .get() as { id: string };
    createProject(db, {
      name: "secret",
      visibility: "private",
      createdBy: admin.id,
    });
    const res = await req("GET", "/api/projects/secret/news/topics", {
      cookie: userCookie,
    });
    expect(res.res.status).toBe(403);
  });

  test("run-now returns 202 and logs", async () => {
    await setupProjectWithAgent();
    const create = await req("POST", "/api/projects/alpha/news/topics", {
      body: {
        name: "AI",
        agent: "researcher",
        updateCron: "0 */6 * * *",
      },
      cookie: adminCookie,
    });
    const id = create.body.topic.id as number;
    queueEvents = [];
    const res = await req(
      "POST",
      `/api/projects/alpha/news/topics/${id}/run-now`,
      { cookie: adminCookie },
    );
    expect(res.res.status).toBe(202);
    expect(
      queueEvents.find(
        (e) => e.topic === "web_news" && e.kind === "topic.run_now",
      ),
    ).toBeDefined();
  });

  test("regenerate-terms zeroes next_renew_terms_at", async () => {
    await setupProjectWithAgent();
    const create = await req("POST", "/api/projects/alpha/news/topics", {
      body: {
        name: "AI",
        agent: "researcher",
        updateCron: "0 */6 * * *",
      },
      cookie: adminCookie,
    });
    const id = create.body.topic.id as number;
    const res = await req(
      "POST",
      `/api/projects/alpha/news/topics/${id}/regenerate-terms`,
      { cookie: adminCookie },
    );
    expect(res.res.status).toBe(200);
    const topicRow = db
      .prepare(`SELECT next_renew_terms_at FROM web_news_topics WHERE id = ?`)
      .get(id) as { next_renew_terms_at: number | null };
    expect(topicRow.next_renew_terms_at).toBe(0);
  });

  test("items list filters by topicId and is project-scoped", async () => {
    await setupProjectWithAgent();
    const admin = db
      .prepare(`SELECT id FROM users WHERE username = 'admin'`)
      .get() as { id: string };
    createProject(db, { name: "beta", createdBy: admin.id });

    const a = await req("POST", "/api/projects/alpha/news/topics", {
      body: { name: "A", agent: "researcher", updateCron: "* * * * *" },
      cookie: adminCookie,
    });

    // Insert one item directly to avoid running the LLM.
    db.prepare(
      `INSERT INTO web_news_items(topic_id, project, title, summary, content_hash,
         first_seen_at, last_seen_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(a.body.topic.id, "alpha", "hi", "", "h1", 1, 1, 1);

    const inProject = await req(`GET`, `/api/projects/alpha/news/items`, {
      cookie: adminCookie,
    });
    expect(inProject.res.status).toBe(200);
    expect(inProject.body.items).toHaveLength(1);

    const inOther = await req("GET", "/api/projects/beta/news/items", {
      cookie: adminCookie,
    });
    expect(inOther.body.items).toHaveLength(0);
  });
});
