/**
 * Ensures the daily stuck-row sweep handler reclaims stale `translating` rows
 * while leaving fresh ones alone. Mirrors the two complementary branches in
 * `sweepStuckTranslating`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../../src/memory/db.ts";
import { createProject } from "../../src/memory/projects.ts";
import { createUser } from "../../src/auth/users.ts";
import { createDefinition } from "../../src/memory/kb_definitions.ts";
import {
  claimPending,
  listTranslations,
  TRANSLATABLE_REGISTRY,
} from "../../src/memory/translatable.ts";
import { sweepStuckHandler } from "../../src/translation/sweep_stuck_handler.ts";
import type { BunnyConfig } from "../../src/config.ts";
import type { BunnyQueue } from "../../src/queue/bunqueue.ts";

let tmp: string;
let db: Database;
let ownerId: string;

const queue: BunnyQueue = { log: async () => {}, close: async () => {} };
const cfg = {
  llm: {
    baseUrl: "",
    apiKey: "",
    model: "x",
    modelReasoning: undefined,
    profile: undefined,
  },
  embed: { baseUrl: "", apiKey: "", model: "x", dim: 1536 },
  memory: { indexReasoning: false, recallK: 8, lastN: 10 },
  render: { reasoning: "collapsed" as const, color: undefined },
  queue: { topics: [] },
  auth: {
    defaultAdminUsername: "a",
    defaultAdminPassword: "b",
    sessionTtlHours: 1,
  },
  agent: { systemPrompt: "", defaultProject: "general", defaultAgent: "bunny" },
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
  sessionId: undefined,
} as unknown as BunnyConfig;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "bunny-sweep-"));
  db = await openDb(join(tmp, "db.sqlite"));
  const u = await createUser(db, {
    username: "a",
    password: "pw-123456789",
    role: "admin",
  });
  ownerId = u.id;
  createProject(db, {
    name: "alpha",
    languages: ["en", "nl"],
    defaultLanguage: "en",
    createdBy: ownerId,
  });
  // Seed a KB definition so we have translation rows to sweep.
  createDefinition(db, {
    project: "alpha",
    term: "Chair",
    createdBy: ownerId,
  });
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

function makeTask(handler: string) {
  return {
    id: "t-1",
    kind: "system" as const,
    handler,
    name: "sweep",
    description: null,
    cronExpr: "0 3 * * *",
    payload: null,
    enabled: true,
    ownerUserId: null,
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    nextRunAt: 0,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe("sweepStuckHandler", () => {
  test("flips stuck translating rows back to pending", async () => {
    const past = Date.now() - 60 * 60_000; // 1h ago — beyond 30m threshold
    claimPending(db, TRANSLATABLE_REGISTRY["kb_definition"]!, 10, past);
    await sweepStuckHandler({
      db,
      queue,
      cfg,
      task: makeTask("translation.sweep_stuck"),
      payload: null,
      now: Date.now(),
    });
    const rows = listTranslations(
      db,
      TRANSLATABLE_REGISTRY["kb_definition"]!,
      1,
    );
    expect(rows.every((r) => r.status === "pending")).toBe(true);
    expect(rows.every((r) => r.translatingAt === null)).toBe(true);
  });

  test("leaves freshly-claimed translating rows alone", async () => {
    const now = Date.now();
    claimPending(db, TRANSLATABLE_REGISTRY["kb_definition"]!, 10, now);
    await sweepStuckHandler({
      db,
      queue,
      cfg,
      task: makeTask("translation.sweep_stuck"),
      payload: null,
      now,
    });
    const rows = listTranslations(
      db,
      TRANSLATABLE_REGISTRY["kb_definition"]!,
      1,
    );
    expect(rows.every((r) => r.status === "translating")).toBe(true);
  });

  test("is a no-op when nothing is stuck", async () => {
    const now = Date.now();
    await sweepStuckHandler({
      db,
      queue,
      cfg,
      task: makeTask("translation.sweep_stuck"),
      payload: null,
      now,
    });
    const rows = listTranslations(
      db,
      TRANSLATABLE_REGISTRY["kb_definition"]!,
      1,
    );
    expect(rows.every((r) => r.status === "pending")).toBe(true);
  });
});
