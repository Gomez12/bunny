/**
 * Integration: POST /api/projects links the configured default agent to the
 * newly-created project (ADR 0031). Covers:
 *  - happy path: bunny shows up in `listAgentsForProject(newProject)`.
 *  - default agent missing: project creation still succeeds (link is best-effort).
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../../src/memory/db.ts";
import { handleApi, type RouteCtx } from "../../src/server/routes.ts";
import { ensureSeedUsers } from "../../src/auth/seed.ts";
import { ensureDefaultAgent } from "../../src/memory/agents_seed.ts";
import {
  deleteAgent,
  isAgentLinkedToProject,
} from "../../src/memory/agents.ts";
import { getProject } from "../../src/memory/projects.ts";
import type { BunnyConfig } from "../../src/config.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Server = any;
let server: Server;
let baseUrl: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch() {
      return new Response("", { status: 200 });
    },
  });
  baseUrl = `http://localhost:${server.port}/v1`;
});
afterAll(() => {
  server.stop(true);
});

let tmp: string;
let db: Database;
let ctx: RouteCtx;

function buildCfg(): BunnyConfig {
  return {
    llm: {
      baseUrl,
      apiKey: "",
      model: "test",
      modelReasoning: undefined,
      profile: "openai",
      maxConcurrentRequests: 1,
    },
    embed: { baseUrl, apiKey: "", model: "text-embedding-3-small", dim: 4 },
    memory: { indexReasoning: false, recallK: 4, lastN: 10 },
    render: { reasoning: "collapsed", color: undefined },
    queue: { topics: [] },
    auth: {
      defaultAdminUsername: "admin",
      defaultAdminPassword: "pw",
      sessionTtlHours: 1,
    },
    agent: {
      systemPrompt: "",
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
        ] as readonly string[],
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
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "bunny-proj-link-"));
  process.env["BUNNY_HOME"] = tmp;
  db = await openDb(join(tmp, "test.sqlite"), 4);
  const cfg = buildCfg();
  await ensureSeedUsers(db, cfg.auth);
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
  delete process.env["BUNNY_HOME"];
});

async function login(): Promise<string> {
  const r = new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "pw" }),
  });
  const res = await handleApi(r, new URL(r.url), ctx);
  if (res.status !== 200) throw new Error(`login ${res.status}`);
  const setCookie = res.headers.get("set-cookie") ?? "";
  const match = setCookie.match(/bunny_session=([^;]+)/);
  return `bunny_session=${match![1]}`;
}

async function changePassword(cookie: string): Promise<void> {
  const r = new Request("http://localhost/api/auth/password", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      currentPassword: "pw",
      newPassword: "new-password-123",
    }),
  });
  await handleApi(r, new URL(r.url), ctx);
}

async function createProjectApi(
  cookie: string,
  name: string,
): Promise<Response> {
  const r = new Request("http://localhost/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ name, visibility: "public" }),
  });
  return handleApi(r, new URL(r.url), ctx);
}

describe("POST /api/projects auto-links default agent (ADR 0031)", () => {
  test("default agent is linked to the new project", async () => {
    ensureDefaultAgent(db, ctx.cfg.agent, ctx.queue);
    const cookie = await login();
    await changePassword(cookie);

    const res = await createProjectApi(cookie, "alpha");
    expect(res.status).toBe(201);
    expect(getProject(db, "alpha")).not.toBeNull();
    expect(isAgentLinkedToProject(db, "alpha", "bunny")).toBe(true);
  });

  test("project creation still succeeds when the default agent is missing", async () => {
    // No prior ensureDefaultAgent call → bunny doesn't exist as a real row.
    deleteAgent(db, "bunny");

    const cookie = await login();
    await changePassword(cookie);

    const res = await createProjectApi(cookie, "beta");
    // The link call is wrapped in try/catch so creation never fails.
    expect(res.status).toBe(201);
    expect(getProject(db, "beta")).not.toBeNull();
  });
});
