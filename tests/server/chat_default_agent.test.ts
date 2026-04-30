/**
 * Integration: POST /api/chat resolves to the configured default agent
 * (ADR 0031). Covers:
 *  - no body.agent + no @mention → messages.author = defaultAgent
 *  - explicit body.agent wins over the default
 *  - leading @agent strips the mention from the prompt
 *  - leading @username (not an agent) falls through to the mention scanner
 *    and the turn's author is still the default agent
 *  - 404 when the configured default agent is missing
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
import { createAgent, linkAgentToProject } from "../../src/memory/agents.ts";
import { ensureDefaultAgent } from "../../src/memory/agents_seed.ts";
import { deleteAgent } from "../../src/memory/agents.ts";
import type { BunnyConfig } from "../../src/config.ts";

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
    code: { cloneTimeoutMs: 300_000, maxRepoSizeMb: 500, defaultCloneDepth: 50, graph: { enabled: true, timeoutMs: 1_800_000, maxFiles: 5000, maxFileSizeKb: 512, maxDocFiles: 100, clusterAlgorithm: "louvain" as const, displayMaxNodes: 300, docExtractionEnabled: false, languages: ["ts","tsx","js","jsx","py","go","rs","java","c","cpp","rb","php"] as readonly string[] } },
  workflows: { bashEnabled: false, bashDefaultTimeoutMs: 120_000, bashMaxOutputBytes: 256 * 1024, scriptEnabled: false, scriptDefaultTimeoutMs: 120_000, scriptMaxOutputBytes: 256 * 1024, loopDefaultMaxIterations: 10 },
    sessionId: undefined,
  };
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "bunny-chat-default-agent-"));
  process.env["BUNNY_HOME"] = tmp;
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
  ensureDefaultAgent(db, cfg.agent, ctx.queue);
});

afterEach(() => {
  db.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  delete process.env["BUNNY_HOME"];
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
  body: {
    prompt: string;
    project?: string;
    sessionId?: string;
    agent?: string;
  },
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
  for (let i = 0; i < 16; i++) {
    const { done } = await reader.read();
    if (done) break;
  }
  await reader.cancel().catch(() => {});
}

function userTurnAuthor(sessionId: string): string | null {
  const row = db
    .prepare(
      `SELECT author FROM messages
         WHERE session_id = ? AND role = 'assistant' AND channel = 'content'
         ORDER BY id ASC LIMIT 1`,
    )
    .get(sessionId) as { author: string | null } | undefined;
  return row?.author ?? null;
}

describe("POST /api/chat default-agent fallback (ADR 0031)", () => {
  test("no body.agent + no @mention → assistant row authored by default agent", async () => {
    const cookie = await login("bob", "pw-bob");
    const res = await chat(cookie, {
      prompt: "hello",
      project: "general",
      sessionId: "chat-default-1",
    });
    expect(res.status).toBe(200);
    await drain(res);
    expect(userTurnAuthor("chat-default-1")).toBe("bunny");
  });

  test("explicit body.agent overrides the default", async () => {
    createAgent(db, {
      name: "mia",
      description: "researcher",
      visibility: "public",
    });
    linkAgentToProject(db, "general", "mia");

    const cookie = await login("bob", "pw-bob");
    const res = await chat(cookie, {
      prompt: "hello",
      project: "general",
      sessionId: "chat-explicit",
      agent: "mia",
    });
    expect(res.status).toBe(200);
    await drain(res);
    expect(userTurnAuthor("chat-explicit")).toBe("mia");
  });

  test("leading @agent strips the mention and sets the author", async () => {
    createAgent(db, {
      name: "mia",
      description: "researcher",
      visibility: "public",
    });
    linkAgentToProject(db, "general", "mia");

    const cookie = await login("bob", "pw-bob");
    const res = await chat(cookie, {
      prompt: "@mia please help",
      project: "general",
      sessionId: "chat-mention-agent",
    });
    expect(res.status).toBe(200);
    await drain(res);
    expect(userTurnAuthor("chat-mention-agent")).toBe("mia");

    const userRow = db
      .prepare(
        `SELECT content FROM messages
           WHERE session_id = 'chat-mention-agent' AND role = 'user' AND channel = 'content'
           LIMIT 1`,
      )
      .get() as { content: string } | undefined;
    expect(userRow?.content).toBe("please help");
  });

  test("leading @username (no matching agent) keeps the default and preserves the prompt", async () => {
    const cookie = await login("bob", "pw-bob");
    const res = await chat(cookie, {
      prompt: "@alice can you look at this?",
      project: "general",
      sessionId: "chat-mention-user",
    });
    expect(res.status).toBe(200);
    await drain(res);
    expect(userTurnAuthor("chat-mention-user")).toBe("bunny");

    const userRow = db
      .prepare(
        `SELECT content FROM messages
           WHERE session_id = 'chat-mention-user' AND role = 'user' AND channel = 'content'
           LIMIT 1`,
      )
      .get() as { content: string } | undefined;
    // Prompt intact — the @alice scanner upstream handles it, the chat route
    // does not strip it because no agent of that name exists.
    expect(userRow?.content).toBe("@alice can you look at this?");
  });

  test("configured default agent missing → 404", async () => {
    // Operator deleted bunny at some point and the boot seeder hasn't re-run.
    deleteAgent(db, "bunny");

    const cookie = await login("bob", "pw-bob");
    const res = await chat(cookie, {
      prompt: "hello",
      project: "general",
      sessionId: "chat-missing-default",
    });
    expect(res.status).toBe(404);
  });
});
