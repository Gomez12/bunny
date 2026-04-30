/**
 * Parser + engine tests for the for_each and if_then_else node kinds and
 * the variable-interpolation / item-resolution helpers.
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
  evalCondition,
  interpolate,
  resolveForEachItems,
  runWorkflow,
} from "../../src/workflows/run_workflow.ts";
import { parseWorkflowToml } from "../../src/workflows/schema.ts";
import type { BunnyConfig } from "../../src/config.ts";

const CFG: BunnyConfig = {
  llm: {
    baseUrl: "http://127.0.0.1:0",
    apiKey: "",
    model: "test",
    modelReasoning: undefined,
    profile: "openai",
  },
  embed: { baseUrl: "http://127.0.0.1:0", apiKey: "", model: "test", dim: 4 },
  memory: { indexReasoning: false, recallK: 0, lastN: 0 },
  render: { reasoning: "hidden", color: false },
  queue: { topics: [] },
  auth: {
    defaultAdminUsername: "admin",
    defaultAdminPassword: "x",
    sessionTtlHours: 1,
  },
  agent: {
    systemPrompt: "t",
    defaultProject: "wf-fk",
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

let tmp: string;
let originalCwd: string;

beforeAll(() => {
  originalCwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), "bunny-fk-"));
  process.chdir(tmp);
});
afterAll(() => {
  process.chdir(originalCwd);
  rmSync(tmp, { recursive: true, force: true });
});

async function seedWorkflow(toml: string): Promise<{
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
  createProject(db, { name: "wf-fk" });
  writeWorkflowToml("wf-fk", "test-wf", toml);
  const wf = createWorkflow(db, {
    project: "wf-fk",
    slug: "test-wf",
    name: "fk",
    description: null,
    tomlSha256: hashWorkflowToml(toml),
    createdBy: "u1",
  });
  return { db, workflowId: wf.id };
}

async function waitDone(db: Database, runId: number, ms = 5000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const run = getRun(db, runId);
    if (run && run.status !== "running" && run.status !== "queued") return run;
    await Bun.sleep(15);
  }
  throw new Error(`run ${runId} still running after ${ms}ms`);
}

describe("interpolate / resolveForEachItems / evalCondition", () => {
  test("interpolate substitutes vars + node outputs", () => {
    const ctx = {
      nodes: { a: "hello" },
      vars: { item: "X", iteration: "3" },
    };
    expect(interpolate("say {{item}}", ctx)).toBe("say X");
    expect(interpolate("iter={{iteration}}", ctx)).toBe("iter=3");
    expect(interpolate("ref={{nodes.a.output}}", ctx)).toBe("ref=hello");
    expect(interpolate("no {{missing}} var", ctx)).toBe("no  var");
  });

  test("resolveForEachItems parses JSON arrays", () => {
    const items = resolveForEachItems(
      { items: '{{nodes.f.output}}', body: [] },
      { nodes: { f: '["a","b","c"]' }, vars: {} },
    );
    expect(items).toEqual(["a", "b", "c"]);
  });

  test("resolveForEachItems splits non-JSON strings on newlines", () => {
    const items = resolveForEachItems(
      { items: "{{nodes.f.output}}", body: [] },
      { nodes: { f: "a.txt\nb.txt\n\nc.txt" }, vars: {} },
    );
    expect(items).toEqual(["a.txt", "b.txt", "c.txt"]);
  });

  test("resolveForEachItems expands count=N into [1..N]", () => {
    const items = resolveForEachItems(
      { count: "{{nodes.f.output}}", body: [] },
      { nodes: { f: "3" }, vars: {} },
    );
    expect(items).toEqual([1, 2, 3]);
  });

  test("evalCondition handles truthy/falsy strings", () => {
    const ctx = { nodes: {}, vars: { v: "true" } };
    expect(evalCondition("{{v}}", ctx)).toBe(true);
    expect(evalCondition("false", ctx)).toBe(false);
    expect(evalCondition("0", ctx)).toBe(false);
    expect(evalCondition("", ctx)).toBe(false);
    expect(evalCondition("yes", ctx)).toBe(true);
  });
});

describe("parseWorkflowToml — for_each / if_then_else", () => {
  test("accepts a valid for_each + body", () => {
    const toml = `name = "x"

[[nodes]]
id = "list"
prompt = "list files"

[[nodes]]
id = "each"
depends_on = ["list"]
[nodes.for_each]
items = "{{nodes.list.output}}"
body = ["work"]

[[nodes]]
id = "work"
prompt = "process {{item}}"
`;
    const { def, errors } = parseWorkflowToml(toml);
    expect(errors).toEqual([]);
    const each = def!.nodes.find((n) => n.id === "each")!;
    expect(each.kind).toBe("for_each");
    expect(each.for_each?.items).toBe("{{nodes.list.output}}");
    expect(each.for_each?.body).toEqual(["work"]);
  });

  test("rejects both items and count on a for_each", () => {
    const { errors } = parseWorkflowToml(`name = "x"
[[nodes]]
id = "a"
prompt = "hi"
[[nodes]]
id = "each"
depends_on = ["a"]
[nodes.for_each]
items = "{{nodes.a.output}}"
count = "3"
body = ["a"]
`);
    expect(errors.some((e) => e.includes("only one of 'items' or 'count'"))).toBe(true);
  });

  test("rejects a body node that appears in two bodies", () => {
    const { errors } = parseWorkflowToml(`name = "x"
[[nodes]]
id = "shared"
prompt = "s"

[[nodes]]
id = "a"
[nodes.for_each]
count = "2"
body = ["shared"]

[[nodes]]
id = "b"
[nodes.for_each]
count = "2"
body = ["shared"]
`);
    expect(errors.some((e) => e.includes("already owned by"))).toBe(true);
  });

  test("rejects if_then_else with both branches empty", () => {
    const { errors } = parseWorkflowToml(`name = "x"
[[nodes]]
id = "gate"
[nodes.if_then_else]
condition = "true"
then_body = []
else_body = []
`);
    expect(errors.some((e) => e.includes("at least one of then_body"))).toBe(true);
  });
});

describe("engine — for_each + if_then_else end-to-end", () => {
  test("for_each iterates the body once per item, binding {{item}} and {{iteration}}", async () => {
    const toml = `name = "fe"

[[nodes]]
id = "list"
prompt = "list"

[[nodes]]
id = "each"
depends_on = ["list"]
[nodes.for_each]
items = "{{nodes.list.output}}"
body = ["work"]

[[nodes]]
id = "work"
prompt = "process {{item}} iter={{iteration}}"
`;
    const { db, workflowId } = await seedWorkflow(toml);
    const queue = createBunnyQueue(db);
    const tools = new ToolRegistry();

    const seen: string[] = [];
    const { run } = runWorkflow({
      db,
      queue,
      cfg: CFG,
      tools,
      workflowId,
      triggeredBy: "u1",
      runAgentImpl: async (opts) => {
        if (opts.prompt.startsWith("process ")) {
          seen.push(opts.prompt);
          return `ok`;
        }
        // list node
        return '["alpha","beta","gamma"]';
      },
    });
    const final = await waitDone(db, run.id);
    expect(final.status).toBe("done");
    expect(seen).toEqual([
      "process alpha iter=1",
      "process beta iter=2",
      "process gamma iter=3",
    ]);
    // Body-owned node 'work' should NOT be top-level — only appear as
    // iteration rows under the for_each.
    const nodes = listRunNodes(db, run.id);
    const workRows = nodes.filter((n) => n.nodeId === "work");
    expect(workRows.length).toBe(3);
    expect(workRows.map((n) => n.iteration).sort()).toEqual([1, 2, 3]);

    await queue.close();
    db.close();
    // keep reference to avoid lint
    void getWorkflowRow;
  });

  test("if_then_else picks the then-branch on truthy condition", async () => {
    const toml = `name = "ite"

[[nodes]]
id = "decide"
prompt = "decide"

[[nodes]]
id = "gate"
depends_on = ["decide"]
[nodes.if_then_else]
condition = "{{nodes.decide.output}}"
then_body = ["ok"]
else_body = ["nope"]

[[nodes]]
id = "ok"
prompt = "ok"

[[nodes]]
id = "nope"
prompt = "nope"
`;
    const { db, workflowId } = await seedWorkflow(toml);
    const queue = createBunnyQueue(db);
    const tools = new ToolRegistry();

    const calls: string[] = [];
    const { run } = runWorkflow({
      db,
      queue,
      cfg: CFG,
      tools,
      workflowId,
      triggeredBy: "u1",
      runAgentImpl: async (opts) => {
        calls.push(opts.prompt);
        if (opts.prompt === "decide") return "yes";
        return "done";
      },
    });
    const final = await waitDone(db, run.id);
    expect(final.status).toBe("done");
    expect(calls).toContain("decide");
    expect(calls).toContain("ok");
    expect(calls).not.toContain("nope");

    await queue.close();
    db.close();
  });

  test("if_then_else picks else-branch on falsy condition", async () => {
    const toml = `name = "ite2"

[[nodes]]
id = "decide"
prompt = "decide"

[[nodes]]
id = "gate"
depends_on = ["decide"]
[nodes.if_then_else]
condition = "{{nodes.decide.output}}"
then_body = ["ok"]
else_body = ["nope"]

[[nodes]]
id = "ok"
prompt = "ok"

[[nodes]]
id = "nope"
prompt = "nope"
`;
    const { db, workflowId } = await seedWorkflow(toml);
    const queue = createBunnyQueue(db);
    const tools = new ToolRegistry();

    const calls: string[] = [];
    const { run } = runWorkflow({
      db,
      queue,
      cfg: CFG,
      tools,
      workflowId,
      triggeredBy: "u1",
      runAgentImpl: async (opts) => {
        calls.push(opts.prompt);
        if (opts.prompt === "decide") return "0";
        return "done";
      },
    });
    const final = await waitDone(db, run.id);
    expect(final.status).toBe("done");
    expect(calls).toContain("nope");
    expect(calls).not.toContain("ok");

    await queue.close();
    db.close();
  });
});
