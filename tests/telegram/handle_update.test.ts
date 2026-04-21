import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../../src/memory/db.ts";
import { createProject } from "../../src/memory/projects.ts";
import { upsertTelegramConfig } from "../../src/memory/telegram_config.ts";
import { upsertLink } from "../../src/memory/telegram_links.ts";
import { createPendingLink } from "../../src/memory/telegram_pending.ts";
import { markSeen } from "../../src/memory/telegram_seen.ts";
import { handleTelegramUpdate } from "../../src/telegram/handle_update.ts";
import type { BunnyConfig } from "../../src/config.ts";
import type { BunnyQueue } from "../../src/queue/bunqueue.ts";
import type { ToolRegistry } from "../../src/tools/registry.ts";
import type { TgUpdate } from "../../src/telegram/types.ts";

let tmp: string;
let db: Database;

type QueueCall = {
  topic?: string;
  kind?: string;
  userId?: string;
  sessionId?: string;
  data?: unknown;
  error?: string;
};
let queueCalls: QueueCall[] = [];

// Minimal fake queue that captures calls.
const fakeQueue: BunnyQueue = {
  async log(entry) {
    queueCalls.push(entry as QueueCall);
  },
  async close() {},
};

const fakeTools = {
  list: () => [],
  call: async () => ({ ok: true, output: "" }),
  subset: () => fakeTools,
} as unknown as ToolRegistry;

const baseCfg: BunnyConfig = {
  llm: {
    baseUrl: "",
    apiKey: "",
    model: "",
    modelReasoning: undefined,
    profile: undefined,
  },
  embed: { baseUrl: "", apiKey: "", model: "", dim: 1536 },
  memory: { indexReasoning: false, recallK: 0, lastN: 0 },
  render: { reasoning: "collapsed", color: undefined },
  queue: { topics: [] },
  auth: {
    defaultAdminUsername: "admin",
    defaultAdminPassword: "x",
    sessionTtlHours: 24,
  },
  agent: { systemPrompt: "", defaultProject: "general", defaultAgent: "bunny" },
  ui: { autosaveIntervalMs: 5_000 },
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
  code: { cloneTimeoutMs: 300_000, maxRepoSizeMb: 500, defaultCloneDepth: 50 },
  workflows: { bashEnabled: false, bashDefaultTimeoutMs: 120_000, bashMaxOutputBytes: 256 * 1024, scriptEnabled: false, scriptDefaultTimeoutMs: 120_000, scriptMaxOutputBytes: 256 * 1024, loopDefaultMaxIterations: 10 },
  sessionId: undefined,
};

function seedUser(db: Database, id: string, username: string) {
  const now = Date.now();
  db.run(
    `INSERT INTO users(id, username, password_hash, role, created_at, updated_at)
     VALUES (?, ?, 'x', 'user', ?, ?)`,
    [id, username, now, now],
  );
}

function makeUpdate(update_id: number, chatId: number, text: string): TgUpdate {
  return {
    update_id,
    message: {
      message_id: update_id,
      chat: { id: chatId, type: "private" },
      date: Math.floor(Date.now() / 1000),
      text,
      from: { id: chatId, is_bot: false, first_name: "U" },
    },
  };
}

beforeEach(async () => {
  queueCalls = [];
  tmp = mkdtempSync(join(tmpdir(), "bunny-tg-handle-"));
  db = await openDb(join(tmp, "test.sqlite"));
  seedUser(db, "u_alice", "alice");
  createProject(db, { name: "alpha", createdBy: "u_alice" });
  upsertTelegramConfig(db, {
    project: "alpha",
    botToken: "fake-token",
    botUsername: "alpha_bot",
  });
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("handleTelegramUpdate", () => {
  test("deduplicates via markSeen — second call is a no-op", async () => {
    // Pre-mark the update as seen.
    markSeen(db, "alpha", 42, Date.now());
    await handleTelegramUpdate({
      db,
      queue: fakeQueue,
      cfg: baseCfg,
      tools: fakeTools,
      project: "alpha",
      update: makeUpdate(42, 7000, "hello"),
    });
    // Nothing should have been logged — handler returned before any work.
    expect(queueCalls.length).toBe(0);
  });

  test("/help replies with canned help and returns", async () => {
    // We can't verify the outbound HTTP call (no real bot), but we can assert
    // no link-required paths ran. The handler swallows send errors, so no
    // queue.log of `message.inbound` must appear.
    await handleTelegramUpdate({
      db,
      queue: fakeQueue,
      cfg: baseCfg,
      tools: fakeTools,
      project: "alpha",
      update: makeUpdate(1, 7000, "/help"),
    });
    expect(
      queueCalls.find((c) => c.kind === "message.inbound"),
    ).toBeUndefined();
  });

  test("/start with valid token creates a link row", async () => {
    const { linkToken } = createPendingLink(db, {
      userId: "u_alice",
      project: "alpha",
    });
    await handleTelegramUpdate({
      db,
      queue: fakeQueue,
      cfg: baseCfg,
      tools: fakeTools,
      project: "alpha",
      update: makeUpdate(10, 7001, `/start ${linkToken}`),
    });
    const row = db
      .prepare(`SELECT user_id FROM user_telegram_links WHERE chat_id = 7001`)
      .get() as { user_id: string } | undefined;
    expect(row?.user_id).toBe("u_alice");
    expect(
      queueCalls.find((c) => c.kind === "link.create.confirm"),
    ).toBeDefined();
  });

  test("unlinked chat gets no-link queue log and no session is started", async () => {
    await handleTelegramUpdate({
      db,
      queue: fakeQueue,
      cfg: baseCfg,
      tools: fakeTools,
      project: "alpha",
      update: makeUpdate(20, 7002, "plain hello"),
    });
    expect(
      queueCalls.find((c) => c.kind === "message.inbound.unlinked"),
    ).toBeDefined();
    expect(
      queueCalls.find((c) => c.kind === "message.inbound"),
    ).toBeUndefined();
  });

  test("group-chat messages are rejected as unsupported", async () => {
    // Even though chat.id is known, type='group' must short-circuit.
    upsertLink(db, { userId: "u_alice", project: "alpha", chatId: 9999 });
    const update: TgUpdate = {
      update_id: 30,
      message: {
        message_id: 30,
        chat: { id: 9999, type: "group" },
        date: Math.floor(Date.now() / 1000),
        text: "ping",
      },
    };
    await handleTelegramUpdate({
      db,
      queue: fakeQueue,
      cfg: baseCfg,
      tools: fakeTools,
      project: "alpha",
      update,
    });
    expect(
      queueCalls.find(
        (c) =>
          c.kind === "message.inbound.unsupported" &&
          typeof c.data === "object" &&
          c.data !== null &&
          (c.data as { chatType?: string }).chatType === "group",
      ),
    ).toBeDefined();
  });

  test("last_update_id advances before processing (poison-message safety)", async () => {
    upsertLink(db, { userId: "u_alice", project: "alpha", chatId: 7003 });
    // Use an unknown chat path (no link) so we don't accidentally hit
    // runAgent (which would fail against an empty LlmConfig).
    await handleTelegramUpdate({
      db,
      queue: fakeQueue,
      cfg: baseCfg,
      tools: fakeTools,
      project: "alpha",
      update: makeUpdate(77, 7100, "no link here"),
    });
    const row = db
      .prepare(
        `SELECT last_update_id FROM project_telegram_config WHERE project = 'alpha'`,
      )
      .get() as { last_update_id: number };
    expect(row.last_update_id).toBe(77);
  });
});
