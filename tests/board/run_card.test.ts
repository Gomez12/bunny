/**
 * End-to-end test for `runCard`: spins up a mock OpenAI-compatible LLM
 * server, points an agent at it, and verifies that running a card persists
 * the run row, mirrors the final answer, and emits SSE events through the
 * fanout.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";

import { openDb } from "../../src/memory/db.ts";
import { createBunnyQueue } from "../../src/queue/bunqueue.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { createProject } from "../../src/memory/projects.ts";
import { createAgent, linkAgentToProject } from "../../src/memory/agents.ts";
import {
  ensureAgentDir,
  writeAgentAssets,
} from "../../src/memory/agent_assets.ts";
import { listSwimlanes } from "../../src/memory/board_swimlanes.ts";
import { createCard } from "../../src/memory/board_cards.ts";
import {
  runCard,
  awaitRunCompletion,
  getRunFanout,
  subscribeToRun,
} from "../../src/board/run_card.ts";
import type { BunnyConfig } from "../../src/config.ts";
import type { SseSink } from "../../src/agent/render_sse.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Server = any;

let server: Server;
let baseUrl: string;
let originalCwd: string;
let tmp: string;

function buildSse(chunks: unknown[]): string {
  return (
    chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") +
    "data: [DONE]\n\n"
  );
}

beforeAll(() => {
  originalCwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), "bunny-runcard-"));
  process.chdir(tmp);

  server = Bun.serve({
    port: 0,
    fetch() {
      const body = buildSse([
        {
          choices: [
            { index: 0, delta: { content: "Plan: " }, finish_reason: null },
          ],
        },
        {
          choices: [
            {
              index: 0,
              delta: { content: "do the thing." },
              finish_reason: "stop",
            },
          ],
        },
      ]);
      return new Response(body, {
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
  process.chdir(originalCwd);
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function makeCfg(): BunnyConfig {
  return {
    llm: {
      baseUrl,
      apiKey: "",
      model: "test",
      modelReasoning: undefined,
      profile: "openai",
    },
    embed: { baseUrl, apiKey: "", model: "test-embed", dim: 4 },
    memory: { indexReasoning: false, recallK: 4, lastN: 10 },
    render: { reasoning: "hidden", color: false },
    queue: { topics: [] },
    auth: {
      defaultAdminUsername: "admin",
      defaultAdminPassword: "x",
      sessionTtlHours: 1,
    },
    agent: { systemPrompt: "You are a tester.", defaultProject: "alpha" },
    ui: { autosaveIntervalMs: 5000 },
    web: {
      serpApiKey: "",
      serpProvider: "serper",
      serpBaseUrl: "",
      userAgent: "",
    },
    sessionId: undefined,
  };
}

async function setup(): Promise<{
  db: Database;
  cfg: BunnyConfig;
  cardId: number;
}> {
  const db = await openDb(join(tmp, `${crypto.randomUUID()}.sqlite`), 4);
  // Seed user for the createdBy FK.
  const now = Date.now();
  db.run(
    `INSERT INTO users(id, username, password_hash, role, created_at, updated_at)
     VALUES ('u1', 'u1', 'x', 'user', ?, ?)`,
    [now, now],
  );
  createProject(db, { name: "alpha" });
  createAgent(db, { name: "researcher" });
  ensureAgentDir("researcher");
  writeAgentAssets("researcher", {
    systemPrompt: { prompt: "You are researcher.", append: false },
  });
  linkAgentToProject(db, "alpha", "researcher");

  const lane = listSwimlanes(db, "alpha")[0]!;
  const card = createCard(db, {
    project: "alpha",
    swimlaneId: lane.id,
    title: "Investigate X",
    description: "Do a deep dive.",
    assigneeAgent: "researcher",
    createdBy: "u1",
  });

  return { db, cfg: makeCfg(), cardId: card.id };
}

describe("runCard", () => {
  test("happy path: persists run, mirrors final answer", async () => {
    const { db, cfg, cardId } = await setup();
    const queue = createBunnyQueue(db);
    const tools = new ToolRegistry();

    const { run, sessionId } = await runCard({
      db,
      queue,
      cfg,
      tools,
      cardId,
      triggeredBy: "u1",
    });
    expect(run.status).toBe("running");
    expect(sessionId).toBeTruthy();

    const finished = await awaitRunCompletion(db, run.id);
    expect(finished.status).toBe("done");
    expect(finished.finalAnswer).toContain("Plan");
    expect(finished.finalAnswer).toContain("do the thing.");

    await queue.close();
    db.close();
  });

  test("rejects when no agent is assigned and no override given", async () => {
    const db = await openDb(join(tmp, `${crypto.randomUUID()}.sqlite`), 4);
    const now = Date.now();
    db.run(
      `INSERT INTO users(id, username, password_hash, role, created_at, updated_at)
       VALUES ('u1', 'u1', 'x', 'user', ?, ?)`,
      [now, now],
    );
    createProject(db, { name: "alpha" });
    const lane = listSwimlanes(db, "alpha")[0]!;
    const card = createCard(db, {
      project: "alpha",
      swimlaneId: lane.id,
      title: "task",
      createdBy: "u1",
    });
    const queue = createBunnyQueue(db);
    await expect(
      runCard({
        db,
        queue,
        cfg: makeCfg(),
        tools: new ToolRegistry(),
        cardId: card.id,
        triggeredBy: "u1",
      }),
    ).rejects.toThrow(/no agent assigned/);
    await queue.close();
    db.close();
  });

  test("rejects when agent is not linked to the project", async () => {
    const db = await openDb(join(tmp, `${crypto.randomUUID()}.sqlite`), 4);
    const now = Date.now();
    db.run(
      `INSERT INTO users(id, username, password_hash, role, created_at, updated_at)
       VALUES ('u1', 'u1', 'x', 'user', ?, ?)`,
      [now, now],
    );
    createProject(db, { name: "alpha" });
    createAgent(db, { name: "ghost" });
    const lane = listSwimlanes(db, "alpha")[0]!;
    const card = createCard(db, {
      project: "alpha",
      swimlaneId: lane.id,
      title: "task",
      createdBy: "u1",
    });
    const queue = createBunnyQueue(db);
    await expect(
      runCard({
        db,
        queue,
        cfg: makeCfg(),
        tools: new ToolRegistry(),
        cardId: card.id,
        agent: "ghost",
        triggeredBy: "u1",
      }),
    ).rejects.toThrow(/not available/);
    await queue.close();
    db.close();
  });

  test("SSE fanout buffers all events for late subscribers", async () => {
    const { db, cfg, cardId } = await setup();
    const queue = createBunnyQueue(db);
    const tools = new ToolRegistry();

    const { run } = await runCard({
      db,
      queue,
      cfg,
      tools,
      cardId,
      triggeredBy: "u1",
    });
    await awaitRunCompletion(db, run.id);

    const fan = getRunFanout(run.id);
    expect(fan).toBeDefined();
    const captured: string[] = [];
    const sink: SseSink = {
      enqueue: (chunk) => captured.push(new TextDecoder().decode(chunk)),
      close: () => undefined,
    };
    subscribeToRun(run.id, sink);
    const joined = captured.join("");
    expect(joined).toContain('"type":"card_run_started"');
    expect(joined).toContain('"type":"content"');
    expect(joined).toContain('"type":"card_run_finished"');

    await queue.close();
    db.close();
  });
});
