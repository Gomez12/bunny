import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../../src/memory/db.ts";
import { createTask, getTask } from "../../src/memory/scheduled_tasks.ts";
import { createHandlerRegistry } from "../../src/scheduler/handlers.ts";
import { startScheduler } from "../../src/scheduler/ticker.ts";
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
  agent: { systemPrompt: "", defaultProject: "general" },
  ui: { autosaveIntervalMs: 5000 },
  web: {
    serpApiKey: "",
    serpProvider: "serper",
    serpBaseUrl: "",
    userAgent: "",
  },
  sessionId: undefined,
} as unknown as BunnyConfig;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "bunny-sched-ticker-"));
  db = await openDb(join(tmp, "db.sqlite"));
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("scheduler ticker", () => {
  test("invokes registered handlers and records success", async () => {
    const registry = createHandlerRegistry();
    const calls: string[] = [];
    registry.register("demo.ping", async ({ task }) => {
      calls.push(task.id);
    });
    const sched = startScheduler({ db, queue, cfg, registry, manual: true });

    const t = createTask(db, {
      kind: "user",
      handler: "demo.ping",
      name: "ping",
      cronExpr: "* * * * *",
      nextRunAt: 0,
    });

    await sched.tick(1_000);
    expect(calls).toEqual([t.id]);
    const after = getTask(db, t.id)!;
    expect(after.lastStatus).toBe("ok");
    expect(after.nextRunAt).toBeGreaterThan(1_000);
  });

  test("unknown handler yields error status but does not block other rows", async () => {
    const registry = createHandlerRegistry();
    const calls: string[] = [];
    registry.register("demo.ok", async ({ task }) => {
      calls.push(task.id);
    });
    const sched = startScheduler({ db, queue, cfg, registry, manual: true });

    const bad = createTask(db, {
      kind: "user",
      handler: "missing.handler",
      name: "bad",
      cronExpr: "* * * * *",
      nextRunAt: 0,
    });
    const good = createTask(db, {
      kind: "user",
      handler: "demo.ok",
      name: "good",
      cronExpr: "* * * * *",
      nextRunAt: 0,
    });

    await sched.tick(500);
    expect(calls).toContain(good.id);
    const badRow = getTask(db, bad.id)!;
    expect(badRow.lastStatus).toBe("error");
    expect(badRow.lastError).toMatch(/no handler/);
  });

  test("handler errors are captured without crashing the tick", async () => {
    const registry = createHandlerRegistry();
    registry.register("demo.boom", async () => {
      throw new Error("nope");
    });
    const sched = startScheduler({ db, queue, cfg, registry, manual: true });
    const t = createTask(db, {
      kind: "user",
      handler: "demo.boom",
      name: "boom",
      cronExpr: "* * * * *",
      nextRunAt: 0,
    });
    await sched.tick(500);
    const after = getTask(db, t.id)!;
    expect(after.lastStatus).toBe("error");
    expect(after.lastError).toBe("nope");
  });
});
