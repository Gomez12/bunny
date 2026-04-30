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
import type { BunnyConfig } from "../../src/config.ts";

let tmp: string;
let db: Database;
let ctx: RouteCtx;
let adminCookie: string;
let userCookie: string;

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
  tmp = mkdtempSync(join(tmpdir(), "bunny-kb-routes-"));
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

describe("KB definitions HTTP surface", () => {
  test("CRUD round-trip", async () => {
    createProject(db, { name: "alpha" });

    // Create
    const create = await req("POST", "/api/projects/alpha/kb/definitions", {
      body: { term: "supplier", manualDescription: "A party that ships parts" },
      cookie: adminCookie,
    });
    expect(create.res.status).toBe(201);
    const def = create.body.definition as { id: number; term: string };
    expect(def.term).toBe("supplier");

    // List
    const list = await req("GET", "/api/projects/alpha/kb/definitions", {
      cookie: adminCookie,
    });
    expect(list.res.status).toBe(200);
    expect((list.body.definitions as unknown[]).length).toBe(1);
    expect(list.body.total).toBe(1);

    // Patch
    const patch = await req(
      "PATCH",
      `/api/projects/alpha/kb/definitions/${def.id}`,
      {
        body: { isProjectDependent: true },
        cookie: adminCookie,
      },
    );
    expect(patch.res.status).toBe(200);
    expect(
      (patch.body.definition as { isProjectDependent: boolean })
        .isProjectDependent,
    ).toBe(true);

    // Active
    const active = await req(
      "POST",
      `/api/projects/alpha/kb/definitions/${def.id}/active`,
      {
        body: { active: "short" },
        cookie: adminCookie,
      },
    );
    expect(active.res.status).toBe(200);
    expect(
      (active.body.definition as { activeDescription: string })
        .activeDescription,
    ).toBe("short");

    // Clear LLM
    const clear = await req(
      "POST",
      `/api/projects/alpha/kb/definitions/${def.id}/clear-llm`,
      {
        cookie: adminCookie,
      },
    );
    expect(clear.res.status).toBe(200);
    expect((clear.body.definition as { llmCleared: boolean }).llmCleared).toBe(
      true,
    );
    // Active resets to manual per the clear semantics.
    expect(
      (clear.body.definition as { activeDescription: string })
        .activeDescription,
    ).toBe("manual");

    // Delete
    const del = await req(
      "DELETE",
      `/api/projects/alpha/kb/definitions/${def.id}`,
      {
        cookie: adminCookie,
      },
    );
    expect(del.res.status).toBe(200);

    const listAfter = await req("GET", "/api/projects/alpha/kb/definitions", {
      cookie: adminCookie,
    });
    expect(listAfter.body.total).toBe(0);
  });

  test("missing term → 400", async () => {
    createProject(db, { name: "alpha" });
    const res = await req("POST", "/api/projects/alpha/kb/definitions", {
      body: { manualDescription: "no term here" },
      cookie: adminCookie,
    });
    expect(res.res.status).toBe(400);
  });

  test("duplicate term in same project → 400", async () => {
    createProject(db, { name: "alpha" });
    await req("POST", "/api/projects/alpha/kb/definitions", {
      body: { term: "supplier" },
      cookie: adminCookie,
    });
    const dup = await req("POST", "/api/projects/alpha/kb/definitions", {
      body: { term: "Supplier" },
      cookie: adminCookie,
    });
    expect(dup.res.status).toBe(400);
  });

  test("non-owner cannot delete someone else's definition", async () => {
    createProject(db, { name: "alpha" });
    const create = await req("POST", "/api/projects/alpha/kb/definitions", {
      body: { term: "supplier" },
      cookie: adminCookie,
    });
    const id = (create.body.definition as { id: number }).id;

    const del = await req(
      "DELETE",
      `/api/projects/alpha/kb/definitions/${id}`,
      {
        cookie: userCookie,
      },
    );
    expect(del.res.status).toBe(403);
  });

  test("invalid active value → 400", async () => {
    createProject(db, { name: "alpha" });
    const create = await req("POST", "/api/projects/alpha/kb/definitions", {
      body: { term: "supplier" },
      cookie: adminCookie,
    });
    const id = (create.body.definition as { id: number }).id;
    const res = await req(
      "POST",
      `/api/projects/alpha/kb/definitions/${id}/active`,
      {
        body: { active: "bogus" },
        cookie: adminCookie,
      },
    );
    expect(res.res.status).toBe(400);
  });

  test("unknown project → 404", async () => {
    const res = await req("GET", "/api/projects/missing/kb/definitions", {
      cookie: adminCookie,
    });
    expect(res.res.status).toBe(404);
  });

  test("clear-illustration wipes the stored SVG and resets status", async () => {
    createProject(db, { name: "alpha" });
    const create = await req("POST", "/api/projects/alpha/kb/definitions", {
      body: { term: "supplier" },
      cookie: adminCookie,
    });
    const id = (create.body.definition as { id: number }).id;

    // Seed an SVG + generated_at + status as if a run had succeeded.
    db.run(
      `UPDATE kb_definitions
         SET svg_content = ?, svg_status = 'idle', svg_generated_at = ?
       WHERE id = ?`,
      ["<svg xmlns='http://www.w3.org/2000/svg'/>", Date.now(), id],
    );

    const clear = await req(
      "POST",
      `/api/projects/alpha/kb/definitions/${id}/clear-illustration`,
      { cookie: adminCookie },
    );
    expect(clear.res.status).toBe(200);
    const def = clear.body.definition as {
      svgContent: string | null;
      svgStatus: string;
      svgGeneratedAt: number | null;
    };
    expect(def.svgContent).toBeNull();
    expect(def.svgStatus).toBe("idle");
    expect(def.svgGeneratedAt).toBeNull();
  });

  test("generate-illustration returns 409 when already running", async () => {
    createProject(db, { name: "alpha" });
    const create = await req("POST", "/api/projects/alpha/kb/definitions", {
      body: { term: "supplier" },
      cookie: adminCookie,
    });
    const id = (create.body.definition as { id: number }).id;

    // Pin the row into the 'generating' state without calling the LLM.
    db.run(`UPDATE kb_definitions SET svg_status = 'generating' WHERE id = ?`, [
      id,
    ]);

    const res = await req(
      "POST",
      `/api/projects/alpha/kb/definitions/${id}/generate-illustration`,
      { cookie: adminCookie },
    );
    expect(res.res.status).toBe(409);
  });

  test("non-owner cannot clear someone else's illustration", async () => {
    createProject(db, { name: "alpha" });
    const create = await req("POST", "/api/projects/alpha/kb/definitions", {
      body: { term: "supplier" },
      cookie: adminCookie,
    });
    const id = (create.body.definition as { id: number }).id;

    const res = await req(
      "POST",
      `/api/projects/alpha/kb/definitions/${id}/clear-illustration`,
      { cookie: userCookie },
    );
    expect(res.res.status).toBe(403);
  });
});
