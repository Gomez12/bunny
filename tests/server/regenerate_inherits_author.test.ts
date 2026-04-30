/**
 * Integration: POST /api/messages/:id/regenerate inherits the responding
 * agent from the target row (ADR 0031). Covers:
 *  - regenerating an assistant row keeps its author
 *  - regenerating a user row inherits the next-assistant's author
 *  - legacy NULL-author chain falls back to the configured default agent
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
import { insertMessage } from "../../src/memory/messages.ts";
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
      defaultAdminPassword: "pw",
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
  tmp = mkdtempSync(join(tmpdir(), "bunny-regen-author-"));
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
  ensureDefaultAgent(db, cfg.agent, ctx.queue);
  createAgent(db, {
    name: "mia",
    description: "researcher",
    visibility: "public",
  });
  linkAgentToProject(db, "general", "mia");
});

afterEach(() => {
  db.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  delete process.env["BUNNY_HOME"];
});

async function login(): Promise<{ cookie: string; userId: string }> {
  const r = new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "pw" }),
  });
  const res = await handleApi(r, new URL(r.url), ctx);
  if (res.status !== 200) {
    // Admin is seeded as mustChangePassword — hit change-password first.
    // But the seed used here is a fresh DB, so the first login should succeed.
    throw new Error(`login failed ${res.status}`);
  }
  const setCookie = res.headers.get("set-cookie") ?? "";
  const match = setCookie.match(/bunny_session=([^;]+)/);
  const body = (await res.json()) as {
    user: { id: string; mustChangePassword?: boolean };
  };
  return { cookie: `bunny_session=${match![1]}`, userId: body.user.id };
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

async function regenerate(
  cookie: string,
  messageId: number,
): Promise<Response> {
  const r = new Request(
    `http://localhost/api/messages/${messageId}/regenerate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({}),
    },
  );
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

function latestAssistantAuthor(
  sessionId: string,
  afterId: number,
): string | null {
  const row = db
    .prepare(
      `SELECT author FROM messages
         WHERE session_id = ? AND role = 'assistant' AND channel = 'content'
           AND id > ?
         ORDER BY id DESC LIMIT 1`,
    )
    .get(sessionId, afterId) as { author: string | null } | undefined;
  return row?.author ?? null;
}

describe("regenerate inherits author (ADR 0031)", () => {
  test("assistant target → new row keeps the same author", async () => {
    const { cookie, userId } = await login();
    await changePassword(cookie);

    const sessionId = "regen-asst";
    insertMessage(db, {
      sessionId,
      role: "user",
      channel: "content",
      content: "Original prompt",
      userId,
      project: "general",
    });
    const assistantId = insertMessage(db, {
      sessionId,
      role: "assistant",
      channel: "content",
      content: "mia's answer",
      author: "mia",
      userId,
      project: "general",
    });

    const res = await regenerate(cookie, assistantId);
    expect(res.status).toBe(200);
    await drain(res);

    expect(latestAssistantAuthor(sessionId, assistantId)).toBe("mia");
  });

  test("user target → inherits next-assistant's author", async () => {
    const { cookie, userId } = await login();
    await changePassword(cookie);

    const sessionId = "regen-user";
    const userId2 = insertMessage(db, {
      sessionId,
      role: "user",
      channel: "content",
      content: "tell me a joke",
      userId,
      project: "general",
    });
    insertMessage(db, {
      sessionId,
      role: "assistant",
      channel: "content",
      content: "...a joke authored by mia",
      author: "mia",
      userId,
      project: "general",
    });

    const res = await regenerate(cookie, userId2);
    expect(res.status).toBe(200);
    await drain(res);

    expect(latestAssistantAuthor(sessionId, userId2)).toBe("mia");
  });

  test("legacy NULL-author assistant → regen falls back to default agent", async () => {
    const { cookie, userId } = await login();
    await changePassword(cookie);

    const sessionId = "regen-legacy";
    insertMessage(db, {
      sessionId,
      role: "user",
      channel: "content",
      content: "hello",
      userId,
      project: "general",
    });
    const legacyAssistantId = insertMessage(db, {
      sessionId,
      role: "assistant",
      channel: "content",
      content: "hi (no author)",
      author: null,
      userId,
      project: "general",
    });

    const res = await regenerate(cookie, legacyAssistantId);
    expect(res.status).toBe(200);
    await drain(res);

    expect(latestAssistantAuthor(sessionId, legacyAssistantId)).toBe("bunny");
  });
});
