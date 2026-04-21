/**
 * Integration: POST /api/chat with @username mentions.
 *
 * Covers:
 *  - `@alice hi` where alice is a user (no such agent) does NOT 404 — the
 *    leading-agent strip only fires when an agent of that name exists.
 *  - The mention scanner fires after the user-turn insert and creates a
 *    notification row for alice.
 *  - A mention in a private project the recipient can't see produces an
 *    aggregated `mention_blocked` counter-row for the sender only.
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
import { createUser } from "../../src/auth/users.ts";
import { createProject } from "../../src/memory/projects.ts";
import type { BunnyConfig } from "../../src/config.ts";
import { listForUser } from "../../src/memory/notifications.ts";
import { ensureDefaultAgent } from "../../src/memory/agents_seed.ts";

// ---------------------------------------------------------------------------
// Mock LLM — returns a one-shot final answer so runAgent completes quickly.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Server = any;
let server: Server;
let baseUrl: string;

function finalAnswerSse(): string {
  const frame = (delta: unknown) =>
    `data: ${JSON.stringify({
      choices: [{ index: 0, delta, finish_reason: null }],
    })}\n\n`;
  const done = `data: ${JSON.stringify({
    choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }],
  })}\n\n`;
  return frame({ content: "ok" }) + done + "data: [DONE]\n\n";
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(finalAnswerSse(), {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        },
      });
    },
  });
  baseUrl = `http://localhost:${server.port}/v1`;
});

afterAll(() => {
  server.stop(true);
});

// ---------------------------------------------------------------------------

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
    },
    embed: { baseUrl, apiKey: "", model: "text-embedding-3-small", dim: 4 },
    memory: { indexReasoning: false, recallK: 4, lastN: 10 },
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
    },
  workflows: { bashEnabled: false, bashDefaultTimeoutMs: 120_000, bashMaxOutputBytes: 256 * 1024, scriptEnabled: false, scriptDefaultTimeoutMs: 120_000, scriptMaxOutputBytes: 256 * 1024, loopDefaultMaxIterations: 10 },
    sessionId: undefined,
  };
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "bunny-chat-mentions-"));
  db = await openDb(join(tmp, "test.sqlite"), 4);
  const cfg = buildCfg();
  await ensureSeedUsers(db, cfg.auth);
  await createUser(db, {
    username: "alice",
    password: "pw-alice",
    displayName: "Alice",
  });
  await createUser(db, {
    username: "bob",
    password: "pw-bob",
    displayName: "Bob",
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
  // Boot-time invariant: seed the default agent + link to projects.
  ensureDefaultAgent(db, cfg.agent, ctx.queue);
});

afterEach(() => {
  db.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

async function login(username: string, password: string): Promise<string> {
  const r = new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const res = await handleApi(r, new URL(r.url), ctx);
  if (res.status !== 200) throw new Error(`login failed ${res.status}`);
  const setCookie = res.headers.get("set-cookie") ?? "";
  const match = setCookie.match(/bunny_session=([^;]+)/);
  return `bunny_session=${match![1]}`;
}

async function chat(
  cookie: string,
  body: { prompt: string; project?: string; sessionId?: string },
): Promise<Response> {
  const r = new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body),
  });
  return handleApi(r, new URL(r.url), ctx);
}

async function drain(res: Response): Promise<void> {
  const reader = res.body!.getReader();
  // read a handful of frames then stop; the stream emits `done` eventually
  // but we don't need to wait that long — the mention dispatch already ran
  // inside the ReadableStream.start() callback.
  for (let i = 0; i < 8; i++) {
    const { done } = await reader.read();
    if (done) break;
  }
  await reader.cancel().catch(() => {});
}

describe("POST /api/chat with @user mentions", () => {
  test("leading @username where no agent matches does NOT 404 and notifies the user", async () => {
    const cookie = await login("bob", "pw-bob");
    const res = await chat(cookie, {
      prompt: "@alice please look at this",
      project: "general",
      sessionId: "chat-1",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    await drain(res);

    const aliceId = (
      db.prepare(`SELECT id FROM users WHERE username = 'alice'`).get() as {
        id: string;
      }
    ).id;
    const rows = listForUser(db, aliceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("mention");
    expect(rows[0]!.actorUsername).toBe("bob");
    expect(rows[0]!.project).toBe("general");
    expect(rows[0]!.deepLink).toContain("session=chat-1");
  });

  test("mention in the middle of a message also notifies", async () => {
    const cookie = await login("bob", "pw-bob");
    const res = await chat(cookie, {
      prompt: "hey @alice can you review?",
      project: "general",
      sessionId: "chat-2",
    });
    expect(res.status).toBe(200);
    await drain(res);
    const aliceId = (
      db.prepare(`SELECT id FROM users WHERE username = 'alice'`).get() as {
        id: string;
      }
    ).id;
    expect(listForUser(db, aliceId)).toHaveLength(1);
  });

  test("private project the recipient can't see → counter-row for sender, nothing for recipient", async () => {
    const bobId = (
      db.prepare(`SELECT id FROM users WHERE username = 'bob'`).get() as {
        id: string;
      }
    ).id;
    const aliceId = (
      db.prepare(`SELECT id FROM users WHERE username = 'alice'`).get() as {
        id: string;
      }
    ).id;
    createProject(db, {
      name: "bobs_private",
      visibility: "private",
      createdBy: bobId,
    });
    // Mirror the POST /api/projects auto-link: every project has the default
    // agent linked so /api/chat can resolve it.
    ensureDefaultAgent(db, ctx.cfg.agent, ctx.queue);
    const cookie = await login("bob", "pw-bob");
    const res = await chat(cookie, {
      prompt: "psst @alice secret",
      project: "bobs_private",
      sessionId: "chat-3",
    });
    expect(res.status).toBe(200);
    await drain(res);

    expect(listForUser(db, aliceId)).toHaveLength(0);
    const bobRows = listForUser(db, bobId);
    expect(bobRows).toHaveLength(1);
    expect(bobRows[0]!.kind).toBe("mention_blocked");
    expect(bobRows[0]!.body).toContain("@alice");
  });

  test("regenerate on a user turn with a mention does NOT re-fire the notification", async () => {
    const cookie = await login("bob", "pw-bob");
    // First turn: mention alice — produces exactly one notification.
    const res = await chat(cookie, {
      prompt: "@alice hi",
      project: "general",
      sessionId: "chat-regen",
    });
    expect(res.status).toBe(200);
    await drain(res);

    const aliceId = (
      db.prepare(`SELECT id FROM users WHERE username = 'alice'`).get() as {
        id: string;
      }
    ).id;
    expect(listForUser(db, aliceId)).toHaveLength(1);

    // Find the user-turn row we just inserted and call /regenerate on it.
    const userRow = db
      .prepare(
        `SELECT id FROM messages WHERE session_id = 'chat-regen' AND role = 'user' ORDER BY id ASC LIMIT 1`,
      )
      .get() as { id: number } | undefined;
    expect(userRow).toBeDefined();

    const regenReq = new Request(
      `http://localhost/api/messages/${userRow!.id}/regenerate`,
      { method: "POST", headers: { Cookie: cookie } },
    );
    const regenRes = await handleApi(regenReq, new URL(regenReq.url), ctx);
    expect(regenRes.status).toBe(200);
    await drain(regenRes);

    // No additional notification — mentionsEnabled is off on the regen path.
    expect(listForUser(db, aliceId)).toHaveLength(1);
  });

  test("self-mention creates nothing", async () => {
    const cookie = await login("bob", "pw-bob");
    const res = await chat(cookie, {
      prompt: "talking to @bob myself",
      project: "general",
      sessionId: "chat-4",
    });
    expect(res.status).toBe(200);
    await drain(res);
    const bobId = (
      db.prepare(`SELECT id FROM users WHERE username = 'bob'`).get() as {
        id: string;
      }
    ).id;
    expect(listForUser(db, bobId)).toHaveLength(0);
  });
});
