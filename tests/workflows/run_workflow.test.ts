/**
 * Engine tests — exercises `runWorkflow` with a mocked `runAgent` to cover
 * prompt-node progression, loop stop-token detection, and interactive gates.
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
import {
  createWorkflow,
  getWorkflow as getWorkflowRow,
} from "../../src/memory/workflows.ts";
import {
  hashWorkflowToml,
  writeWorkflowToml,
} from "../../src/memory/workflow_assets.ts";
import {
  getRun,
  listRunNodes,
} from "../../src/memory/workflow_runs.ts";
import {
  requestCancelWorkflowRun,
  runWorkflow,
} from "../../src/workflows/run_workflow.ts";
import {
  answerPendingQuestion,
  __resetPendingQuestionsForTests,
} from "../../src/agent/ask_user_registry.ts";
import type { BunnyConfig } from "../../src/config.ts";

let originalCwd: string;
let tmp: string;

beforeAll(() => {
  originalCwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), "bunny-wf-engine-"));
  process.chdir(tmp);
});

afterAll(() => {
  process.chdir(originalCwd);
  rmSync(tmp, { recursive: true, force: true });
});

const CFG: BunnyConfig = {
  llm: {
    baseUrl: "http://127.0.0.1:0",
    apiKey: "",
    model: "test",
    modelReasoning: undefined,
    profile: "openai",
    maxConcurrentRequests: 1,
  },
  embed: {
    baseUrl: "http://127.0.0.1:0",
    apiKey: "",
    model: "test",
    dim: 4,
  },
  memory: { indexReasoning: false, recallK: 0, lastN: 0 },
  render: { reasoning: "hidden", color: false },
  queue: { topics: [] },
  auth: {
    defaultAdminUsername: "admin",
    defaultAdminPassword: "x",
    sessionTtlHours: 1,
  },
  agent: {
    systemPrompt: "You are a tester.",
    defaultProject: "wf-test",
    defaultAgent: "bunny",
  },
  ui: { autosaveIntervalMs: 5000 },
  web: { serpApiKey: "", serpProvider: "serper", serpBaseUrl: "", userAgent: "" },
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
  workflows: {
    bashEnabled: false,
    bashDefaultTimeoutMs: 120_000,
    bashMaxOutputBytes: 256 * 1024,
    scriptEnabled: false,
    scriptDefaultTimeoutMs: 120_000,
    scriptMaxOutputBytes: 256 * 1024,
    loopDefaultMaxIterations: 10,
  },
  sessionId: undefined,
};

async function setupWorkflow(toml: string): Promise<{
  db: Database;
  workflowId: number;
}> {
  const db = await openDb(join(tmp, `${crypto.randomUUID()}.sqlite`), 4);
  const now = Date.now();
  db.run(
    `INSERT INTO users(id, username, password_hash, role, created_at, updated_at)
     VALUES ('u1', 'u1', 'x', 'user', ?, ?)`,
    [now, now],
  );
  createProject(db, { name: "wf-test" });
  writeWorkflowToml("wf-test", "test-wf", toml);
  const wf = createWorkflow(db, {
    project: "wf-test",
    slug: "test-wf",
    name: "test wf",
    description: null,
    tomlSha256: hashWorkflowToml(toml),
    createdBy: "u1",
  });
  return { db, workflowId: wf.id };
}

async function waitForRunDone(db: Database, runId: number, ms = 5000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const run = getRun(db, runId);
    if (run && run.status !== "running" && run.status !== "queued") return run;
    await Bun.sleep(15);
  }
  throw new Error(`run ${runId} still running after ${ms}ms`);
}

describe("runWorkflow", () => {
  test("serial prompt nodes finish in declaration order", async () => {
    const toml = `name = "ser"

[[nodes]]
id = "one"
prompt = "do one"

[[nodes]]
id = "two"
depends_on = ["one"]
prompt = "do two"
`;
    const { db, workflowId } = await setupWorkflow(toml);
    const queue = createBunnyQueue(db);
    const tools = new ToolRegistry();

    let calls = 0;
    const { run } = runWorkflow({
      db,
      queue,
      cfg: CFG,
      tools,
      workflowId,
      triggeredBy: "u1",
      runAgentImpl: async (_opts) => {
        calls++;
        return `answer ${calls}`;
      },
    });

    const final = await waitForRunDone(db, run.id);
    expect(final.status).toBe("done");
    expect(calls).toBe(2);
    const nodes = listRunNodes(db, run.id);
    expect(nodes.map((n) => n.nodeId)).toEqual(["one", "two"]);
    expect(nodes.every((n) => n.status === "done")).toBe(true);

    await queue.close();
    db.close();
  });

  test("loop terminates on stop-token", async () => {
    const toml = `name = "loop"

[[nodes]]
id = "iter"

[nodes.loop]
prompt = "Implement next task"
until = "ALL_TASKS_COMPLETE"
`;
    const { db, workflowId } = await setupWorkflow(toml);
    const queue = createBunnyQueue(db);
    const tools = new ToolRegistry();

    let call = 0;
    const { run } = runWorkflow({
      db,
      queue,
      cfg: CFG,
      tools,
      workflowId,
      triggeredBy: "u1",
      runAgentImpl: async () => {
        call++;
        // Stop on the 3rd iteration.
        return call < 3 ? "keep going" : "done now <<<ALL_TASKS_COMPLETE>>>";
      },
    });

    const final = await waitForRunDone(db, run.id, 8000);
    expect(final.status).toBe("done");
    expect(call).toBe(3);
    const nodes = listRunNodes(db, run.id);
    expect(nodes.filter((n) => n.nodeId === "iter").length).toBe(3);

    await queue.close();
    db.close();
  });

  test("loop bails out after max_iterations", async () => {
    const toml = `name = "loop"

[[nodes]]
id = "iter"

[nodes.loop]
prompt = "never stops"
until = "APPROVED"
max_iterations = 2
`;
    const { db, workflowId } = await setupWorkflow(toml);
    const queue = createBunnyQueue(db);
    const tools = new ToolRegistry();

    const { run } = runWorkflow({
      db,
      queue,
      cfg: CFG,
      tools,
      workflowId,
      triggeredBy: "u1",
      runAgentImpl: async () => "still working",
    });

    const final = await waitForRunDone(db, run.id, 5000);
    expect(final.status).toBe("error");
    expect(final.error).toContain("did not reach stop condition");

    await queue.close();
    db.close();
  });

  test("interactive node waits for user answer and stores it", async () => {
    __resetPendingQuestionsForTests();
    const toml = `name = "approve-only"

[[nodes]]
id = "gate"
interactive = true
`;
    const { db, workflowId } = await setupWorkflow(toml);
    const queue = createBunnyQueue(db);
    const tools = new ToolRegistry();

    const { run, sessionId } = runWorkflow({
      db,
      queue,
      cfg: CFG,
      tools,
      workflowId,
      triggeredBy: "u1",
    });

    // Give the engine a tick to emit the ask-user question.
    await Bun.sleep(30);
    const ok = answerPendingQuestion(
      sessionId,
      `run:${run.id}:node:gate:approve`,
      "Approve",
    );
    expect(ok).toBe(true);

    const final = await waitForRunDone(db, run.id, 3000);
    expect(final.status).toBe("done");
    const nodes = listRunNodes(db, run.id);
    expect(nodes[0]!.resultText).toBe("Approve");

    await queue.close();
    db.close();
  });

  test("cancel unblocks an interactive node immediately", async () => {
    __resetPendingQuestionsForTests();
    const toml = `name = "cancel-me"

[[nodes]]
id = "gate"
interactive = true
`;
    const { db, workflowId } = await setupWorkflow(toml);
    const queue = createBunnyQueue(db);
    const tools = new ToolRegistry();

    const { run } = runWorkflow({
      db,
      queue,
      cfg: CFG,
      tools,
      workflowId,
      triggeredBy: "u1",
    });

    // Let the engine emit the ask-user event and park on waitForAnswer.
    await Bun.sleep(30);
    expect(requestCancelWorkflowRun(run.id)).toBe(true);

    const final = await waitForRunDone(db, run.id, 1500);
    expect(final.status).toBe("cancelled");

    await queue.close();
    db.close();
  });

  test("bash nodes are rejected when bash_enabled is false", async () => {
    const toml = `name = "bash-off"

[[nodes]]
id = "sh"
bash = "echo hi"
`;
    const { db, workflowId } = await setupWorkflow(toml);
    const queue = createBunnyQueue(db);
    const tools = new ToolRegistry();

    const { run } = runWorkflow({
      db,
      queue,
      cfg: CFG,
      tools,
      workflowId,
      triggeredBy: "u1",
    });
    const final = await waitForRunDone(db, run.id, 2000);
    expect(final.status).toBe("error");
    expect(final.error).toContain("bash is disabled");
    expect(getWorkflowRow(db, workflowId)?.bashApprovals).toEqual({});

    await queue.close();
    db.close();
  });
});
