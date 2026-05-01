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
import { listSwimlanes } from "../../src/memory/board_swimlanes.ts";
import { createCard } from "../../src/memory/board_cards.ts";
import { createRun, markRunDone } from "../../src/memory/board_runs.ts";
import type { BunnyConfig } from "../../src/config.ts";

let tmp: string;
let db: Database;
let ctx: RouteCtx;
let adminCookie: string;

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
  tmp = mkdtempSync(join(tmpdir(), "bunny-board-routes-"));
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
  adminCookie = await login("admin", "pw-initial");
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
  return { res, body };
}

async function login(username: string, password: string): Promise<string> {
  const res = await req("POST", "/api/auth/login", {
    body: { username, password },
  });
  const setCookie = res.res.headers.get("set-cookie") ?? "";
  const match = setCookie.match(/bunny_session=([^;]+)/);
  if (!match) throw new Error("no cookie returned");
  return `bunny_session=${match[1]}`;
}

describe("GET /api/projects/:p/board", () => {
  test("returns swimlanes + cards for a public project", async () => {
    createProject(db, { name: "alpha" });
    const lane = listSwimlanes(db, "alpha")[0]!;
    createCard(db, {
      project: "alpha",
      swimlaneId: lane.id,
      title: "first",
      createdBy: "anyone",
    });
    const { res, body } = await req("GET", "/api/projects/alpha/board", {
      cookie: adminCookie,
    });
    expect(res.status).toBe(200);
    const dto = body as {
      project: string;
      swimlanes: unknown[];
      cards: unknown[];
    };
    expect(dto.project).toBe("alpha");
    expect(dto.swimlanes.length).toBe(3);
    expect(dto.cards.length).toBe(1);
  });

  test("backfills default lanes for legacy projects with none", async () => {
    // Insert a project row directly to simulate a pre-board project — bypasses
    // the createProject seed.
    const now = Date.now();
    db.run(
      `INSERT INTO projects(name, description, visibility, created_by, created_at, updated_at)
       VALUES ('legacy', NULL, 'public', NULL, ?, ?)`,
      [now, now],
    );
    expect(listSwimlanes(db, "legacy")).toHaveLength(0);
    const { res, body } = await req("GET", "/api/projects/legacy/board", {
      cookie: adminCookie,
    });
    expect(res.status).toBe(200);
    expect((body as { swimlanes: unknown[] }).swimlanes).toHaveLength(3);
    // Persisted to DB.
    expect(listSwimlanes(db, "legacy")).toHaveLength(3);
  });

  test("404 for unknown project", async () => {
    const { res } = await req("GET", "/api/projects/missing/board", {
      cookie: adminCookie,
    });
    expect(res.status).toBe(404);
  });

  test("403 for non-admin on private project", async () => {
    await createUser(db, { username: "bob", password: "pw-bob" });
    const bobCookie = await login("bob", "pw-bob");
    createProject(db, { name: "secret", visibility: "private" });
    const { res } = await req("GET", "/api/projects/secret/board", {
      cookie: bobCookie,
    });
    expect(res.status).toBe(403);
  });

  test("401 without cookie", async () => {
    const { res } = await req("GET", "/api/projects/general/board");
    expect(res.status).toBe(401);
  });
});

describe("GET /api/cards/:id", () => {
  test("returns card + runs", async () => {
    createProject(db, { name: "alpha" });
    const lane = listSwimlanes(db, "alpha")[0]!;
    const card = createCard(db, {
      project: "alpha",
      swimlaneId: lane.id,
      title: "x",
      assigneeAgent: "researcher",
      createdBy: "u1",
    });
    const run = createRun(db, {
      cardId: card.id,
      sessionId: "s1",
      agent: "researcher",
      triggeredBy: "u1",
    });
    markRunDone(db, run.id, { finalAnswer: "done" });
    const { res, body } = await req("GET", `/api/cards/${card.id}`, {
      cookie: adminCookie,
    });
    expect(res.status).toBe(200);
    const dto = body as {
      card: { title: string };
      runs: { status: string; finalAnswer: string }[];
    };
    expect(dto.card.title).toBe("x");
    expect(dto.runs).toHaveLength(1);
    expect(dto.runs[0]!.status).toBe("done");
    expect(dto.runs[0]!.finalAnswer).toBe("done");
  });

  test("404 for unknown card", async () => {
    const { res } = await req("GET", "/api/cards/9999", {
      cookie: adminCookie,
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/projects/:p/swimlanes", () => {
  test("admin creates lane", async () => {
    createProject(db, { name: "alpha" });
    const { res, body } = await req("POST", "/api/projects/alpha/swimlanes", {
      cookie: adminCookie,
      body: { name: "Review" },
    });
    expect(res.status).toBe(201);
    expect((body as { swimlane: { name: string } }).swimlane.name).toBe(
      "Review",
    );
  });

  test("non-owner gets 403", async () => {
    await createUser(db, { username: "bob", password: "pw-bob" });
    const bobCookie = await login("bob", "pw-bob");
    createProject(db, { name: "alpha" }); // admin owns implicitly via createdBy=null → only admin passes
    const { res } = await req("POST", "/api/projects/alpha/swimlanes", {
      cookie: bobCookie,
      body: { name: "X" },
    });
    expect(res.status).toBe(403);
  });

  test("missing name → 400", async () => {
    createProject(db, { name: "alpha" });
    const { res } = await req("POST", "/api/projects/alpha/swimlanes", {
      cookie: adminCookie,
      body: {},
    });
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/swimlanes/:id", () => {
  test("admin renames lane", async () => {
    createProject(db, { name: "alpha" });
    const lane = listSwimlanes(db, "alpha")[0]!;
    const { res, body } = await req("PATCH", `/api/swimlanes/${lane.id}`, {
      cookie: adminCookie,
      body: { name: "Backlog" },
    });
    expect(res.status).toBe(200);
    expect((body as { swimlane: { name: string } }).swimlane.name).toBe(
      "Backlog",
    );
  });
});

describe("DELETE /api/swimlanes/:id", () => {
  test("refuses lane with active cards", async () => {
    createProject(db, { name: "alpha" });
    const lane = listSwimlanes(db, "alpha")[0]!;
    createCard(db, {
      project: "alpha",
      swimlaneId: lane.id,
      title: "x",
      createdBy: "u1",
    });
    const { res } = await req("DELETE", `/api/swimlanes/${lane.id}`, {
      cookie: adminCookie,
    });
    expect(res.status).toBe(400);
  });

  test("deletes empty lane", async () => {
    createProject(db, { name: "alpha" });
    const lane = listSwimlanes(db, "alpha")[2]!; // Done is empty
    const { res } = await req("DELETE", `/api/swimlanes/${lane.id}`, {
      cookie: adminCookie,
    });
    expect(res.status).toBe(200);
  });
});

describe("POST /api/projects/:p/cards", () => {
  test("creates card with creator stamp", async () => {
    createProject(db, { name: "alpha" });
    const lane = listSwimlanes(db, "alpha")[0]!;
    const { res, body } = await req("POST", "/api/projects/alpha/cards", {
      cookie: adminCookie,
      body: { swimlaneId: lane.id, title: "task" },
    });
    expect(res.status).toBe(201);
    const dto = body as { card: { title: string; createdBy: string } };
    expect(dto.card.title).toBe("task");
    expect(dto.card.createdBy).toBeTruthy();
  });

  test("rejects swimlane from another project", async () => {
    createProject(db, { name: "alpha" });
    createProject(db, { name: "beta" });
    const otherLane = listSwimlanes(db, "beta")[0]!;
    const { res } = await req("POST", "/api/projects/alpha/cards", {
      cookie: adminCookie,
      body: { swimlaneId: otherLane.id, title: "x" },
    });
    expect(res.status).toBe(400);
  });

  test("rejects unlinked agent", async () => {
    createProject(db, { name: "alpha" });
    const lane = listSwimlanes(db, "alpha")[0]!;
    const { res } = await req("POST", "/api/projects/alpha/cards", {
      cookie: adminCookie,
      body: { swimlaneId: lane.id, title: "x", assigneeAgent: "ghost" },
    });
    expect(res.status).toBe(400);
  });

  test("missing title → 400", async () => {
    createProject(db, { name: "alpha" });
    const lane = listSwimlanes(db, "alpha")[0]!;
    const { res } = await req("POST", "/api/projects/alpha/cards", {
      cookie: adminCookie,
      body: { swimlaneId: lane.id },
    });
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/cards/:id", () => {
  test("creator can patch own card", async () => {
    await createUser(db, { username: "bob", password: "pw-bob" });
    const bobCookie = await login("bob", "pw-bob");
    createProject(db, { name: "alpha" });
    const lane = listSwimlanes(db, "alpha")[0]!;
    const created = await req("POST", "/api/projects/alpha/cards", {
      cookie: bobCookie,
      body: { swimlaneId: lane.id, title: "first" },
    });
    const cardId = (created.body as { card: { id: number } }).card.id;
    const patched = await req("PATCH", `/api/cards/${cardId}`, {
      cookie: bobCookie,
      body: { title: "renamed" },
    });
    expect(patched.res.status).toBe(200);
  });

  test("random user cannot patch", async () => {
    await createUser(db, { username: "alice", password: "pw-alice" });
    await createUser(db, { username: "carol", password: "pw-carol" });
    const aliceCookie = await login("alice", "pw-alice");
    const carolCookie = await login("carol", "pw-carol");
    createProject(db, { name: "alpha" });
    const lane = listSwimlanes(db, "alpha")[0]!;
    const created = await req("POST", "/api/projects/alpha/cards", {
      cookie: aliceCookie,
      body: { swimlaneId: lane.id, title: "x" },
    });
    const cardId = (created.body as { card: { id: number } }).card.id;
    const patched = await req("PATCH", `/api/cards/${cardId}`, {
      cookie: carolCookie,
      body: { title: "nope" },
    });
    expect(patched.res.status).toBe(403);
  });
});

describe("POST /api/cards/:id/move", () => {
  test("admin moves card across lanes", async () => {
    createProject(db, { name: "alpha" });
    const [todo, doing] = listSwimlanes(db, "alpha");
    const card = createCard(db, {
      project: "alpha",
      swimlaneId: todo!.id,
      title: "x",
      createdBy: "u1",
    });
    const { res, body } = await req("POST", `/api/cards/${card.id}/move`, {
      cookie: adminCookie,
      body: { swimlaneId: doing!.id },
    });
    expect(res.status).toBe(200);
    expect((body as { card: { swimlaneId: number } }).card.swimlaneId).toBe(
      doing!.id,
    );
  });
});

describe("DELETE /api/cards/:id (archive)", () => {
  test("archives card; subsequent board GET excludes it", async () => {
    createProject(db, { name: "alpha" });
    const lane = listSwimlanes(db, "alpha")[0]!;
    const card = createCard(db, {
      project: "alpha",
      swimlaneId: lane.id,
      title: "x",
      createdBy: "u1",
    });
    const { res } = await req("DELETE", `/api/cards/${card.id}`, {
      cookie: adminCookie,
    });
    expect(res.status).toBe(200);
    const board = await req("GET", "/api/projects/alpha/board", {
      cookie: adminCookie,
    });
    expect((board.body as { cards: unknown[] }).cards).toHaveLength(0);
  });
});

describe("GET /api/cards/:id/runs", () => {
  test("returns runs in newest-first order", async () => {
    createProject(db, { name: "alpha" });
    const lane = listSwimlanes(db, "alpha")[0]!;
    const card = createCard(db, {
      project: "alpha",
      swimlaneId: lane.id,
      title: "x",
      assigneeAgent: "a",
      createdBy: "u1",
    });
    const r1 = createRun(db, {
      cardId: card.id,
      sessionId: "s1",
      agent: "a",
      triggeredBy: "u1",
    });
    await Bun.sleep(2);
    const r2 = createRun(db, {
      cardId: card.id,
      sessionId: "s2",
      agent: "a",
      triggeredBy: "u1",
    });
    const { res, body } = await req("GET", `/api/cards/${card.id}/runs`, {
      cookie: adminCookie,
    });
    expect(res.status).toBe(200);
    const dto = body as { runs: { id: number }[] };
    expect(dto.runs.map((r) => r.id)).toEqual([r2.id, r1.id]);
  });
});
