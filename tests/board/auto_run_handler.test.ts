import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../../src/memory/db.ts";
import { createProject } from "../../src/memory/projects.ts";
import { createUser } from "../../src/auth/users.ts";
import { createCard, getCard } from "../../src/memory/board_cards.ts";
import {
  createSwimlane,
  listSwimlanes,
  updateSwimlane,
} from "../../src/memory/board_swimlanes.ts";
import { linkAgentToProject, createAgent } from "../../src/memory/agents.ts";
import { boardAutoRunHandler } from "../../src/board/auto_run_handler.ts";
import type { BunnyQueue } from "../../src/queue/bunqueue.ts";
import type { BunnyConfig } from "../../src/config.ts";

let tmp: string;
let db: Database;

const queue: BunnyQueue = { log: async () => {}, close: async () => {} };
const cfg = {
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
} as unknown as BunnyConfig;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "bunny-auto-run-"));
  db = await openDb(join(tmp, "db.sqlite"));
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function seedProjectWithAgent() {
  const u = await createUser(db, {
    username: "owner",
    password: "pw-123456789",
    role: "user",
  });
  await createProject(db, {
    name: "demo",
    description: null,
    visibility: "public",
    createdBy: u.id,
  });
  await createAgent(db, {
    name: "A",
    description: "",
    visibility: "public",
    isSubagent: false,
    knowsOtherAgents: false,
    contextScope: "full",
    createdBy: u.id,
  });
  linkAgentToProject(db, "demo", "A");
  return { userId: u.id };
}

describe("boardAutoRunHandler", () => {
  test("clears auto_run on candidates in auto-run lanes", async () => {
    const { userId } = await seedProjectWithAgent();
    const lane = listSwimlanes(db, "demo").find((l) => l.name === "Todo")!;
    updateSwimlane(db, lane.id, { autoRun: true });
    const card = createCard(db, {
      project: "demo",
      swimlaneId: lane.id,
      title: "do work",
      assigneeAgent: "A",
      createdBy: userId,
    });
    expect(card.autoRun).toBe(true);

    // The real handler spawns `runCard` which talks to the LLM. The closest
    // we can check without network is that the auto_run flag is cleared (the
    // atomic reservation that prevents duplicate enqueues). Any downstream
    // failure inside runCard is caught + logged by the handler.
    await boardAutoRunHandler({
      db,
      queue,
      cfg,
      task: {
        id: "sys-1",
        kind: "system",
        handler: "board.auto_run_scan",
        name: "scan",
        description: null,
        cronExpr: "*/5 * * * *",
        payload: null,
        enabled: true,
        ownerUserId: null,
        lastRunAt: null,
        lastStatus: null,
        lastError: null,
        nextRunAt: 0,
        createdAt: 0,
        updatedAt: 0,
      },
      payload: null,
      now: Date.now(),
    }).catch(() => undefined);

    const after = getCard(db, card.id)!;
    expect(after.autoRun).toBe(false);
  });

  test("caps how many candidates are processed per tick", async () => {
    const { userId } = await seedProjectWithAgent();
    const lane = listSwimlanes(db, "demo").find((l) => l.name === "Todo")!;
    updateSwimlane(db, lane.id, { autoRun: true });

    // Seed 10 eligible cards. The handler is supposed to claim at most
    // MAX_PER_TICK = 3 per invocation so a runaway lane can't fan out
    // beyond the LLM gate's capacity.
    const cards: number[] = [];
    for (let i = 0; i < 10; i++) {
      const c = createCard(db, {
        project: "demo",
        swimlaneId: lane.id,
        title: `do ${i}`,
        assigneeAgent: "A",
        createdBy: userId,
      });
      cards.push(c.id);
    }

    await boardAutoRunHandler({
      db,
      queue,
      cfg,
      task: {
        id: "sys-1",
        kind: "system",
        handler: "board.auto_run_scan",
        name: "scan",
        description: null,
        cronExpr: "*/5 * * * *",
        payload: null,
        enabled: true,
        ownerUserId: null,
        lastRunAt: null,
        lastStatus: null,
        lastError: null,
        nextRunAt: 0,
        createdAt: 0,
        updatedAt: 0,
      },
      payload: null,
      now: Date.now(),
    }).catch(() => undefined);

    // clearAutoRun is called for every candidate the handler tries to run, so
    // counting still-flagged cards equals (total - processed_per_tick).
    const stillFlagged = cards.filter((id) => getCard(db, id)?.autoRun).length;
    expect(stillFlagged).toBeGreaterThanOrEqual(7);
    expect(10 - stillFlagged).toBeLessThanOrEqual(3);
  });

  test("leaves cards in non-auto-run lanes untouched", async () => {
    const { userId } = await seedProjectWithAgent();
    const lane = listSwimlanes(db, "demo").find((l) => l.name === "Todo")!;
    // Lane defaults to autoRun=false.
    const card = createCard(db, {
      project: "demo",
      swimlaneId: lane.id,
      title: "idle",
      assigneeAgent: "A",
      createdBy: userId,
    });
    await boardAutoRunHandler({
      db,
      queue,
      cfg,
      task: {
        id: "sys-1",
        kind: "system",
        handler: "board.auto_run_scan",
        name: "scan",
        description: null,
        cronExpr: "*/5 * * * *",
        payload: null,
        enabled: true,
        ownerUserId: null,
        lastRunAt: null,
        lastStatus: null,
        lastError: null,
        nextRunAt: 0,
        createdAt: 0,
        updatedAt: 0,
      },
      payload: null,
      now: Date.now(),
    }).catch(() => undefined);
    const after = getCard(db, card.id)!;
    expect(after.autoRun).toBe(true);
  });
});
