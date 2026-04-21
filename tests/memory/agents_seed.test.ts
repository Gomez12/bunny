import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "../../src/memory/db.ts";
import { ensureSeedUsers } from "../../src/auth/seed.ts";
import { createProject, ensureProject } from "../../src/memory/projects.ts";
import { ensureDefaultAgent } from "../../src/memory/agents_seed.ts";
import {
  getAgent,
  isAgentLinkedToProject,
  deleteAgent,
} from "../../src/memory/agents.ts";
import type { BunnyQueue, LogPayload } from "../../src/queue/bunqueue.ts";
import type { AgentConfig } from "../../src/config.ts";

const AUTH_CFG = {
  defaultAdminUsername: "admin",
  defaultAdminPassword: "change-me",
  sessionTtlHours: 24,
} as const;

const AGENT_CFG: AgentConfig = {
  systemPrompt: "",
  defaultProject: "general",
  defaultAgent: "bunny",
};

function stubQueue(): { queue: BunnyQueue; logs: LogPayload[] } {
  const logs: LogPayload[] = [];
  const queue: BunnyQueue = {
    async log(p: LogPayload) {
      logs.push(p);
    },
    async close() {},
  };
  return { queue, logs };
}

let tmp: string;
let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env["BUNNY_HOME"];
  tmp = mkdtempSync(join(tmpdir(), "bunny-agents-seed-"));
  process.env["BUNNY_HOME"] = tmp;
});
afterEach(() => {
  if (originalHome === undefined) delete process.env["BUNNY_HOME"];
  else process.env["BUNNY_HOME"] = originalHome;
  rmSync(tmp, { recursive: true, force: true });
});

async function freshDb() {
  const db = await openDb(join(tmp, "test.sqlite"));
  await ensureSeedUsers(db, AUTH_CFG);
  return db;
}

describe("ensureDefaultAgent", () => {
  test("creates the default agent, its config.toml, and links to every project", async () => {
    const db = await freshDb();
    ensureProject(db, "general");
    createProject(db, { name: "alpha" });
    createProject(db, { name: "beta" });

    const { queue, logs } = stubQueue();
    ensureDefaultAgent(db, AGENT_CFG, queue);

    const row = getAgent(db, "bunny");
    expect(row).not.toBeNull();
    expect(row?.visibility).toBe("public");
    expect(row?.contextScope).toBe("full");
    expect(row?.isSubagent).toBe(false);

    expect(isAgentLinkedToProject(db, "general", "bunny")).toBe(true);
    expect(isAgentLinkedToProject(db, "alpha", "bunny")).toBe(true);
    expect(isAgentLinkedToProject(db, "beta", "bunny")).toBe(true);

    const tomlPath = join(tmp, "agents", "bunny", "config.toml");
    expect(existsSync(tomlPath)).toBe(true);
    const toml = readFileSync(tomlPath, "utf8");
    expect(toml).toContain("You are a helpful assistant");
    expect(toml).toContain("append = true");

    expect(
      logs.some((l) => l.topic === "agent" && l.kind === "seed.default"),
    ).toBe(true);
  });

  test("is idempotent", async () => {
    const db = await freshDb();
    ensureProject(db, "general");

    const { queue } = stubQueue();
    ensureDefaultAgent(db, AGENT_CFG, queue);
    // Second call must not throw and must not create duplicate rows.
    expect(() => ensureDefaultAgent(db, AGENT_CFG, queue)).not.toThrow();
    const count = db
      .prepare(`SELECT COUNT(*) AS c FROM agents WHERE name = 'bunny'`)
      .get() as { c: number };
    expect(count.c).toBe(1);
  });

  test("preserves operator edits to config.toml", async () => {
    const db = await freshDb();
    ensureProject(db, "general");
    const { queue } = stubQueue();
    ensureDefaultAgent(db, AGENT_CFG, queue);

    // Delete the agent row but leave the config.toml alone, then re-seed.
    // The writer is a no-op when the file is already on disk.
    const tomlPath = join(tmp, "agents", "bunny", "config.toml");
    const before = readFileSync(tomlPath, "utf8");
    deleteAgent(db, "bunny");
    ensureDefaultAgent(db, AGENT_CFG, queue);
    const after = readFileSync(tomlPath, "utf8");
    expect(after).toBe(before);
  });

  test("warns and returns on invalid agent name — does not throw", async () => {
    const db = await freshDb();
    const { queue } = stubQueue();
    const bad: AgentConfig = {
      systemPrompt: "",
      defaultProject: "general",
      defaultAgent: "not a valid name!!",
    };
    expect(() => ensureDefaultAgent(db, bad, queue)).not.toThrow();
    // Row should not exist — bail-out path.
    expect(getAgent(db, "not a valid name!!")).toBeNull();
  });
});
