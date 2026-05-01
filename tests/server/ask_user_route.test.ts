import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../../src/memory/db.ts";
import { handleApi, type RouteCtx } from "../../src/server/routes.ts";
import { ensureSeedUsers } from "../../src/auth/seed.ts";
import type { BunnyConfig } from "../../src/config.ts";
import {
  __resetPendingQuestionsForTests,
  waitForAnswer,
} from "../../src/agent/ask_user_registry.ts";

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
  tmp = mkdtempSync(join(tmpdir(), "bunny-ask-user-"));
  db = await openDb(join(tmp, "test.sqlite"));
  await ensureSeedUsers(db, cfg.auth);
  __resetPendingQuestionsForTests();
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
});

afterEach(() => {
  db.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  __resetPendingQuestionsForTests();
});

async function loginAdmin(): Promise<string> {
  const r = new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "pw-initial" }),
  });
  const res = await handleApi(r, new URL(r.url), ctx);
  if (res.status !== 200) {
    throw new Error(`login failed ${res.status}`);
  }
  const setCookie = res.headers.get("set-cookie") ?? "";
  const match = setCookie.match(/bunny_session=([^;]+)/);
  if (!match) throw new Error("no session cookie");
  return `bunny_session=${match[1]}`;
}

async function post(path: string, body: unknown, cookie: string) {
  const r = new Request("http://localhost" + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
    },
    body: JSON.stringify(body),
  });
  const res = await handleApi(r, new URL(r.url), ctx);
  const ct = res.headers.get("content-type") ?? "";
  const body2 = ct.includes("application/json")
    ? await res.json()
    : await res.text();
  return { status: res.status, body: body2 as Record<string, unknown> };
}

describe("POST /api/sessions/:id/questions/:qid/answer", () => {
  test("delivers the answer to a waiting tool and returns ok", async () => {
    const cookie = await loginAdmin();
    const sessionId = "sess-1";
    const questionId = "q-1";

    const waiter = waitForAnswer(sessionId, questionId, 5_000);
    // Yield so the waiter is definitely registered.
    await Promise.resolve();

    const { status, body } = await post(
      `/api/sessions/${sessionId}/questions/${questionId}/answer`,
      { answer: "blue" },
      cookie,
    );
    expect(status).toBe(200);
    expect(body["ok"]).toBe(true);

    await expect(waiter).resolves.toBe("blue");
  });

  test("returns 404 when no question is pending", async () => {
    const cookie = await loginAdmin();
    const { status, body } = await post(
      "/api/sessions/nope/questions/nope/answer",
      { answer: "ignored" },
      cookie,
    );
    expect(status).toBe(404);
    expect(body["error"]).toMatch(/no pending question/);
  });

  test("rejects missing answer field", async () => {
    const cookie = await loginAdmin();
    const { status, body } = await post(
      "/api/sessions/sess/questions/qid/answer",
      {},
      cookie,
    );
    expect(status).toBe(400);
    expect(body["error"]).toMatch(/answer/i);
  });

  test("rejects unauthenticated requests", async () => {
    const r = new Request(
      "http://localhost/api/sessions/sess/questions/qid/answer",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer: "x" }),
      },
    );
    const res = await handleApi(r, new URL(r.url), ctx);
    expect(res.status).toBe(401);
  });
});
