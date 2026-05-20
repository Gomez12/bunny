/**
 * Integration test: SafeError is forwarded to the response body, plain
 * `Error.message` is masked.
 *
 * The masking is the security barrier that closes CodeQL alert
 * `js/stack-trace-exposure` (#13).
 *
 * Exercises real route handlers through `handleApi` so we cover both
 * the response wrapper (`json({ error })`) and the
 * `requireProjectAccess` helper that funnels validator throws into the
 * JSON body.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";

import { ensureSeedUsers } from "../../src/auth/seed.ts";
import { openDb } from "../../src/memory/db.ts";
import { createProject } from "../../src/memory/projects.ts";
import { handleApi, type RouteCtx } from "../../src/server/routes.ts";
import { INTERNAL_ERROR_MESSAGE } from "../../src/util/error.ts";
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
  code: {
    cloneTimeoutMs: 300_000,
    maxRepoSizeMb: 500,
    defaultCloneDepth: 50,
    graph: {
      enabled: false,
      timeoutMs: 1_800_000,
      maxFiles: 5000,
      maxFileSizeKb: 512,
      maxDocFiles: 100,
      clusterAlgorithm: "louvain" as const,
      displayMaxNodes: 300,
      docExtractionEnabled: false,
      languages: ["ts"],
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
  scripts: {
    bunPath: "",
    dotnetPath: "",
    pythonPath: "",
    powershellPath: "",
    goPath: "",
    execTimeoutMs: 30_000,
    maxOutputBytes: 10_485_760,
    maxVersionsPerScript: 50,
    syncCron: "*/5 * * * *",
  },
  diary: {
    whisperCppPath: "",
    whisperModelPath: "",
    whisperLanguage: "nl",
    whisperTimeoutMs: 300000,
  },
  planning: {
    suggestionRefreshCron: "*/5 * * * *",
    suggestionRefreshBatchSize: 5,
    notifyDeadlineConflictDedupMs: 86_400_000,
    reportSnapshotCron: "0 8 * * 1",
    reportSnapshotEnabled: true,
    maxReportsPerProject: 50,
  },
  calendar: { countryCode: "NL" },
  sessionId: undefined,
};

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "bunny-safe-error-"));
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
  createProject(db, { name: "alpha" });
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
  const body = (await res.json()) as { error?: string };
  return { res, body };
}

async function login(username: string, password: string): Promise<string> {
  const r = await req("POST", "/api/auth/login", {
    body: { username, password },
  });
  const setCookie = r.res.headers.get("set-cookie") ?? "";
  const m = setCookie.match(/bunny_session=([^;]+)/);
  if (!m) throw new Error("no session cookie returned");
  return `bunny_session=${m[1]}`;
}

describe("SafeError response masking", () => {
  test("forwards SafeError messages to the client", async () => {
    // `validateSlugName` (now a SafeError thrower) trips on the leading
    // dot of "../escape", surfacing via `requireProjectAccess` → 400.
    const r = await req("POST", "/api/projects/..%2Fescape/planning", {
      cookie: adminCookie,
      body: { name: "q1" },
    });
    expect(r.res.status).toBe(400);
    expect(typeof r.body.error).toBe("string");
    // The validator's user-facing message is preserved verbatim, not
    // replaced by the internal-error mask.
    expect(r.body.error).not.toBe(INTERNAL_ERROR_MESSAGE);
    expect(r.body.error).toContain("project");
  });

  test("forwards a SafeError httpStatus (404) end-to-end", async () => {
    // `restoreVersion` throws `new SafeError("version not found: …",
    // { httpStatus: 404 })` when the requested version row is absent.
    // The route catch must surface that status, not its old uniform 400.
    const r = await req("POST", "/api/versions/agent/does-not-exist/restore", {
      cookie: adminCookie,
      body: { version: 1 },
    });
    expect(r.res.status).toBe(404);
    expect(r.body.error).toContain("not found");
  });

  test("masks plain Error.message thrown from a route handler", async () => {
    // Stub a single statement in the prepared `projects` table to force
    // a SQLite RANGE error on the next read — the route catch block
    // must surface it as the generic INTERNAL_ERROR_MESSAGE, not the
    // raw "no such column" / "constraint" text.
    db.exec("DROP TABLE planning_projects");

    const r = await req("POST", "/api/projects/alpha/planning", {
      cookie: adminCookie,
      body: { name: "q1" },
    });
    expect(r.res.status).toBe(400);
    expect(r.body.error).toBe(INTERNAL_ERROR_MESSAGE);
  });
});
