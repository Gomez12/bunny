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
const ORIGINAL_HOME = process.env["BUNNY_HOME"];

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
  code: {
    cloneTimeoutMs: 300_000,
    maxRepoSizeMb: 500,
    defaultCloneDepth: 50,
    graph: {
      enabled: true,
      timeoutMs: 1_800_000,
      maxFiles: 5000,
      maxFileSizeKb: 512,
      maxDocFiles: 100,
      clusterAlgorithm: "louvain" as const,
      displayMaxNodes: 300,
      docExtractionEnabled: false,
      languages: [
        "ts",
        "tsx",
        "js",
        "jsx",
        "py",
        "go",
        "rs",
        "java",
        "c",
        "cpp",
        "rb",
        "php",
      ],
    },
  },
  workflows: {
    bashEnabled: false,
    bashDefaultTimeoutMs: 120_000,
    bashMaxOutputBytes: 256 * 1024,
    scriptEnabled: false,
    scriptDefaultTimeoutMs: 120_000,
    scriptMaxOutputBytes: 256 * 1024,
    loopDefaultMaxIterations: 10,
  },
  contacts: {
    soulRefreshCron: "0 */6 * * *",
    soulRefreshBatchSize: 5,
    soulRefreshCadenceH: 24,
    soulStuckThresholdMs: 1_800_000,
    translateSoul: true,
  },
  businesses: {
    autoBuildEnabled: false,
    autoBuildCron: "30 */6 * * *",
    autoBuildBatchSize: 3,
    soulRefreshCron: "0 */6 * * *",
    soulRefreshBatchSize: 5,
    soulRefreshCadenceH: 24,
    soulStuckThresholdMs: 1_800_000,
    translateSoul: true,
  },
  sessionId: undefined,
};

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "bunny-ws-routes-"));
  process.env["BUNNY_HOME"] = tmp;
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
  if (ORIGINAL_HOME === undefined) delete process.env["BUNNY_HOME"];
  else process.env["BUNNY_HOME"] = ORIGINAL_HOME;
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

async function req(
  method: string,
  path: string,
  opts: {
    body?: unknown;
    cookie?: string;
    bodyRaw?: string | Uint8Array;
    headers?: Record<string, string>;
  } = {},
) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.body && !opts.bodyRaw) headers["Content-Type"] = "application/json";
  if (opts.cookie) headers["Cookie"] = opts.cookie;
  const r = new Request("http://localhost" + path, {
    method,
    headers,
    body: opts.bodyRaw ?? (opts.body ? JSON.stringify(opts.body) : undefined),
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
  const m = setCookie.match(/bunny_session=([^;]+)/);
  if (!m) throw new Error("no cookie");
  return `bunny_session=${m[1]}`;
}

describe("workspace routes", () => {
  beforeEach(() => {
    createProject(db, { name: "alpha" });
  });

  test("401 without auth", async () => {
    const { res } = await req("GET", "/api/projects/alpha/workspace/list");
    expect(res.status).toBe(401);
  });

  test("list returns seeded input/output on fresh project", async () => {
    const { res, body } = await req(
      "GET",
      "/api/projects/alpha/workspace/list",
      { cookie: adminCookie },
    );
    expect(res.status).toBe(200);
    const names = (body as { entries: Array<{ name: string }> }).entries.map(
      (e) => e.name,
    );
    expect(names).toContain("input");
    expect(names).toContain("output");
  });

  test("JSON upload → read round-trip", async () => {
    const up = await req("POST", "/api/projects/alpha/workspace/file", {
      cookie: adminCookie,
      body: { path: "output/hi.txt", content: "hello" },
    });
    expect(up.res.status).toBe(201);
    const dl = await req(
      "GET",
      "/api/projects/alpha/workspace/file?path=output/hi.txt",
      { cookie: adminCookie },
    );
    expect(dl.res.status).toBe(200);
    expect((dl.body as { content: string }).content).toBe("hello");
  });

  test("raw download returns file bytes with Content-Type", async () => {
    await req("POST", "/api/projects/alpha/workspace/file", {
      cookie: adminCookie,
      body: { path: "readme.md", content: "# hi" },
    });
    const r = await req(
      "GET",
      "/api/projects/alpha/workspace/file?path=readme.md&encoding=raw",
      {
        cookie: adminCookie,
      },
    );
    expect(r.res.status).toBe(200);
    expect(r.body).toBe("# hi");
  });

  test("mkdir + move + delete flow", async () => {
    const mk = await req("POST", "/api/projects/alpha/workspace/mkdir", {
      cookie: adminCookie,
      body: { path: "notes" },
    });
    expect(mk.res.status).toBe(201);

    await req("POST", "/api/projects/alpha/workspace/file", {
      cookie: adminCookie,
      body: { path: "notes/a.txt", content: "A" },
    });

    const mv = await req("POST", "/api/projects/alpha/workspace/move", {
      cookie: adminCookie,
      body: { from: "notes/a.txt", to: "notes/b.txt" },
    });
    expect(mv.res.status).toBe(200);

    const del = await req(
      "DELETE",
      "/api/projects/alpha/workspace?path=" + encodeURIComponent("notes/b.txt"),
      { cookie: adminCookie },
    );
    expect(del.res.status).toBe(200);
  });

  test("path traversal returns 400", async () => {
    const r = await req(
      "GET",
      "/api/projects/alpha/workspace/file?path=../../etc/passwd",
      {
        cookie: adminCookie,
      },
    );
    expect(r.res.status).toBe(400);
  });

  test("delete of protected input/output is rejected", async () => {
    const r = await req("DELETE", "/api/projects/alpha/workspace?path=input", {
      cookie: adminCookie,
    });
    expect(r.res.status).toBe(400);
  });

  test("403 for non-admin viewer on private project writes", async () => {
    // Switch alpha to private, owned by the admin user, so bob is a viewer.
    const adminRow = db
      .prepare<
        { id: string },
        [string]
      >(`SELECT id FROM users WHERE username = ?`)
      .get("admin") as { id: string } | null;
    expect(adminRow).not.toBeNull();
    db.run(
      `UPDATE projects SET visibility='private', created_by=? WHERE name='alpha'`,
      [adminRow!.id],
    );
    await createUser(db, { username: "bob", password: "pw-bob" });
    const bob = await login("bob", "pw-bob");

    // Viewer can't even see this private project → 403 on list.
    const list = await req("GET", "/api/projects/alpha/workspace/list", {
      cookie: bob,
    });
    expect(list.res.status).toBe(403);

    // Make it public; bob can now read but not write.
    db.run(`UPDATE projects SET visibility='public' WHERE name='alpha'`);
    const list2 = await req("GET", "/api/projects/alpha/workspace/list", {
      cookie: bob,
    });
    expect(list2.res.status).toBe(200);

    const up = await req("POST", "/api/projects/alpha/workspace/file", {
      cookie: bob,
      body: { path: "nope.txt", content: "x" },
    });
    expect(up.res.status).toBe(403);
  });
});
