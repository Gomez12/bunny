/**
 * Outbound-hook smoke test. We don't exercise the real Bot API here — the
 * helper suppresses silently when no link exists for the user, so we verify
 * that:
 *
 *   1. No link → no queue log of `message.outbound`.
 *   2. Telegram disabled → no queue log of `message.outbound`.
 *   3. With a link + enabled bot, the helper attempts an outbound call. The
 *      fetch will fail because the token is fake, but an `error` queue event
 *      must land (never swallowed silently).
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
import { createProject } from "../../src/memory/projects.ts";
import {
  patchTelegramConfig,
  upsertTelegramConfig,
} from "../../src/memory/telegram_config.ts";
import { upsertLink } from "../../src/memory/telegram_links.ts";
import { sendTelegramToUser } from "../../src/telegram/outbound.ts";
import type { BunnyQueue } from "../../src/queue/bunqueue.ts";

let tmp: string;
let db: Database;
let queueCalls: { kind?: string }[] = [];
const queue: BunnyQueue = {
  async log(entry) {
    queueCalls.push(entry as { kind?: string });
  },
  async close() {},
};
const tgCfg = {
  pollLeaseMs: 50_000,
  chunkChars: 4000,
  documentFallbackBytes: 16 * 1024,
  publicBaseUrl: "",
};

function seedUser(db: Database, id: string, username: string) {
  const now = Date.now();
  db.run(
    `INSERT INTO users(id, username, password_hash, role, created_at, updated_at)
     VALUES (?, ?, 'x', 'user', ?, ?)`,
    [id, username, now, now],
  );
}

// Deterministic stub for Telegram's Bot API. `ok: false` envelopes are what
// production sees on auth/token errors; returning one here lets us assert the
// error-log path without hitting the live API.
const realFetch = globalThis.fetch;
type FetchInput = Parameters<typeof fetch>[0];
let fetchStub:
  | ((input: FetchInput, init?: RequestInit) => Promise<Response>)
  | null = null;

beforeAll(() => {
  globalThis.fetch = (async (input, init) => {
    if (fetchStub) return fetchStub(input as FetchInput, init);
    return realFetch(input as FetchInput, init);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

beforeEach(async () => {
  queueCalls = [];
  tmp = mkdtempSync(join(tmpdir(), "bunny-tg-outbound-"));
  db = await openDb(join(tmp, "test.sqlite"));
  seedUser(db, "u_alice", "alice");
  createProject(db, { name: "alpha", createdBy: null });
});

afterEach(() => {
  fetchStub = null;
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("sendTelegramToUser", () => {
  test("no-op silently when the user has no link for the project", async () => {
    upsertTelegramConfig(db, {
      project: "alpha",
      botToken: "fake",
      botUsername: "alpha_bot",
    });
    await sendTelegramToUser(db, queue, tgCfg, {
      userId: "u_alice",
      project: "alpha",
      text: "hi",
    });
    expect(queueCalls.length).toBe(0);
  });

  test("no-op when Telegram is disabled on the project", async () => {
    upsertTelegramConfig(db, {
      project: "alpha",
      botToken: "fake",
      botUsername: "alpha_bot",
    });
    upsertLink(db, { userId: "u_alice", project: "alpha", chatId: 111 });
    patchTelegramConfig(db, "alpha", { enabled: false });
    await sendTelegramToUser(db, queue, tgCfg, {
      userId: "u_alice",
      project: "alpha",
      text: "hi",
    });
    expect(queueCalls.length).toBe(0);
  });

  test("logs error (not outbound) when the bot API call fails", async () => {
    upsertTelegramConfig(db, {
      project: "alpha",
      botToken: "bogus-token",
      botUsername: "alpha_bot",
    });
    upsertLink(db, { userId: "u_alice", project: "alpha", chatId: 111 });
    // Stub fetch to simulate Telegram returning 401 Unauthorized.
    fetchStub = async () =>
      new Response(
        JSON.stringify({
          ok: false,
          error_code: 401,
          description: "Unauthorized",
        }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        },
      );
    await sendTelegramToUser(db, queue, tgCfg, {
      userId: "u_alice",
      project: "alpha",
      text: "hi",
    });
    expect(queueCalls.find((c) => c.kind === "error")).toBeDefined();
    expect(
      queueCalls.find((c) => c.kind === "message.outbound"),
    ).toBeUndefined();
  });

  test("logs outbound message when the bot API call succeeds", async () => {
    upsertTelegramConfig(db, {
      project: "alpha",
      botToken: "fake-token",
      botUsername: "alpha_bot",
    });
    upsertLink(db, { userId: "u_alice", project: "alpha", chatId: 111 });
    fetchStub = async () =>
      new Response(
        JSON.stringify({
          ok: true,
          result: { message_id: 123 },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    await sendTelegramToUser(db, queue, tgCfg, {
      userId: "u_alice",
      project: "alpha",
      text: "hi",
      source: "test",
    });
    const ob = queueCalls.find((c) => c.kind === "message.outbound");
    expect(ob).toBeDefined();
    expect(queueCalls.find((c) => c.kind === "error")).toBeUndefined();
  });
});
