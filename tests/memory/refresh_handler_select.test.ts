import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../../src/memory/db.ts";
import { createProject } from "../../src/memory/projects.ts";
import { createAgent, linkAgentToProject } from "../../src/memory/agents.ts";
import { insertMessage } from "../../src/memory/messages.ts";
import {
  ensureUserProjectMemory,
  setUserProjectMemoryAuto,
} from "../../src/memory/user_project_memory.ts";
import {
  ensureAgentProjectMemory,
  setAgentProjectMemoryAuto,
} from "../../src/memory/agent_project_memory.ts";
import {
  listActiveAgentProjectPairs,
  listActiveSoulUsers,
  listActiveUserProjectPairs,
} from "../../src/memory/refresh_handler.ts";

let tmp: string;
let db: Database;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "bunny-mr-"));
  db = await openDb(join(tmp, "db.sqlite"));
  const now = Date.now();
  db.run(
    `INSERT INTO users(id, username, password_hash, role, created_at, updated_at)
     VALUES ('alice', 'alice', 'x', 'user', ?, ?)`,
    [now, now],
  );
  db.run(
    `INSERT INTO users(id, username, password_hash, role, created_at, updated_at)
     VALUES ('bob', 'bob', 'x', 'user', ?, ?)`,
    [now, now],
  );
  createProject(db, { name: "alpha", createdBy: "alice" });
  createProject(db, { name: "beta", createdBy: "alice" });
  createAgent(db, {
    name: "researcher",
    description: "",
    visibility: "public",
    createdBy: "alice",
  });
  linkAgentToProject(db, "alpha", "researcher");
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("memory.refresh candidate selection", () => {
  test("listActiveUserProjectPairs returns pairs with messages past their watermark", () => {
    insertMessage(db, {
      sessionId: "s1",
      userId: "alice",
      project: "alpha",
      role: "user",
      content: "hello",
    });
    insertMessage(db, {
      sessionId: "s1",
      userId: "alice",
      project: "alpha",
      role: "assistant",
      content: "hi alice",
    });
    const pairs = listActiveUserProjectPairs(db, 10);
    expect(pairs.length).toBe(1);
    expect(pairs[0]!.userId).toBe("alice");
    expect(pairs[0]!.project).toBe("alpha");
    expect(pairs[0]!.watermark).toBe(0);
    expect(pairs[0]!.maxId).toBeGreaterThan(0);
  });

  test("listActiveUserProjectPairs skips pairs already caught up", () => {
    insertMessage(db, {
      sessionId: "s1",
      userId: "alice",
      project: "alpha",
      role: "user",
      content: "hi",
    });
    const pairs1 = listActiveUserProjectPairs(db, 10);
    expect(pairs1.length).toBe(1);
    ensureUserProjectMemory(db, "alice", "alpha");
    setUserProjectMemoryAuto(db, "alice", "alpha", "seed", pairs1[0]!.maxId);
    const pairs2 = listActiveUserProjectPairs(db, 10);
    expect(pairs2.length).toBe(0);
  });

  test("listActiveUserProjectPairs skips refreshing rows", () => {
    insertMessage(db, {
      sessionId: "s1",
      userId: "alice",
      project: "alpha",
      role: "user",
      content: "hi",
    });
    ensureUserProjectMemory(db, "alice", "alpha");
    db.run(
      `UPDATE user_project_memory SET status = 'refreshing' WHERE user_id = ? AND project = ?`,
      ["alice", "alpha"],
    );
    const pairs = listActiveUserProjectPairs(db, 10);
    expect(pairs.length).toBe(0);
  });

  test("listActiveAgentProjectPairs picks up sessions where the agent has authored", () => {
    insertMessage(db, {
      sessionId: "s1",
      userId: "alice",
      project: "alpha",
      role: "user",
      content: "research X",
    });
    insertMessage(db, {
      sessionId: "s1",
      userId: "alice",
      project: "alpha",
      role: "assistant",
      author: "researcher",
      content: "found Y",
    });
    const pairs = listActiveAgentProjectPairs(db, 10);
    expect(pairs.length).toBe(1);
    expect(pairs[0]!.agent).toBe("researcher");
    expect(pairs[0]!.project).toBe("alpha");
  });

  test("listActiveAgentProjectPairs skips already-caught-up agents", () => {
    insertMessage(db, {
      sessionId: "s1",
      userId: "alice",
      project: "alpha",
      role: "assistant",
      author: "researcher",
      content: "msg",
    });
    const before = listActiveAgentProjectPairs(db, 10);
    expect(before.length).toBe(1);
    ensureAgentProjectMemory(db, "researcher", "alpha");
    setAgentProjectMemoryAuto(
      db,
      "researcher",
      "alpha",
      "seed",
      before[0]!.maxId,
    );
    const after = listActiveAgentProjectPairs(db, 10);
    expect(after.length).toBe(0);
  });

  test("listActiveSoulUsers ignores users with no activity", () => {
    insertMessage(db, {
      sessionId: "s1",
      userId: "alice",
      project: "alpha",
      role: "user",
      content: "first",
    });
    const users = listActiveSoulUsers(db, 10);
    expect(users.length).toBe(1);
    expect(users[0]!.userId).toBe("alice");
    expect(users[0]!.watermark).toBe(0);
    expect(users[0]!.maxId).toBeGreaterThan(0);
  });

  test("listActiveSoulUsers skips users whose soul watermark is current", () => {
    const id = insertMessage(db, {
      sessionId: "s1",
      userId: "alice",
      project: "alpha",
      role: "user",
      content: "msg",
    });
    db.run(
      `UPDATE users SET soul_watermark_message_id = ? WHERE id = 'alice'`,
      [id],
    );
    const users = listActiveSoulUsers(db, 10);
    expect(users.length).toBe(0);
  });

  test("listActiveSoulUsers skips users currently in refreshing", () => {
    insertMessage(db, {
      sessionId: "s1",
      userId: "alice",
      project: "alpha",
      role: "user",
      content: "msg",
    });
    db.run(`UPDATE users SET soul_status = 'refreshing' WHERE id = 'alice'`);
    const users = listActiveSoulUsers(db, 10);
    expect(users.length).toBe(0);
  });

  test("listActiveUserProjectPairs ignores fromAutomation rows", () => {
    insertMessage(db, {
      sessionId: "web-news-x",
      userId: "alice",
      project: "alpha",
      role: "user",
      content: "fetch news",
      fromAutomation: true,
    });
    insertMessage(db, {
      sessionId: "web-news-x",
      userId: "alice",
      project: "alpha",
      role: "assistant",
      content: "headlines",
      fromAutomation: true,
    });
    const pairs = listActiveUserProjectPairs(db, 10);
    expect(pairs.length).toBe(0);
  });

  test("listActiveSoulUsers ignores fromAutomation rows", () => {
    insertMessage(db, {
      sessionId: "web-news-x",
      userId: "alice",
      project: "alpha",
      role: "user",
      content: "fetch news",
      fromAutomation: true,
    });
    const souls = listActiveSoulUsers(db, 10);
    expect(souls.length).toBe(0);
  });

  test("listActiveAgentProjectPairs ignores fromAutomation rows", () => {
    insertMessage(db, {
      sessionId: "web-news-x",
      userId: "alice",
      project: "alpha",
      role: "assistant",
      author: "researcher",
      content: "automation reply",
      fromAutomation: true,
    });
    const pairs = listActiveAgentProjectPairs(db, 10);
    expect(pairs.length).toBe(0);
  });

  test("listActiveAgentProjectPairs nested SELECT MAX honours fromAutomation", () => {
    // Real human prompt to alice — bumps the agent's session into scope.
    insertMessage(db, {
      sessionId: "real-1",
      userId: "alice",
      project: "alpha",
      role: "user",
      content: "research X",
    });
    // Agent answer that IS real (catches the agent into the active set).
    insertMessage(db, {
      sessionId: "real-1",
      userId: "alice",
      project: "alpha",
      role: "assistant",
      author: "researcher",
      content: "found Y",
    });
    // Pre-stamp watermark to the agent's last real reply.
    const before = listActiveAgentProjectPairs(db, 10);
    expect(before.length).toBe(1);
    ensureAgentProjectMemory(db, "researcher", "alpha");
    setAgentProjectMemoryAuto(
      db,
      "researcher",
      "alpha",
      "seed",
      before[0]!.maxId,
    );
    expect(listActiveAgentProjectPairs(db, 10).length).toBe(0);

    // A scheduled assistant turn in the same session must NOT inflate max_id
    // past the watermark — proves both the outer m and nested SELECT MAX(m2)
    // carry `from_automation = 0`.
    insertMessage(db, {
      sessionId: "real-1",
      userId: "alice",
      project: "alpha",
      role: "assistant",
      author: "researcher",
      content: "card-run reply",
      fromAutomation: true,
    });
    const after = listActiveAgentProjectPairs(db, 10);
    expect(after.length).toBe(0);
  });

  test("mixed-session: real row still arms refresh, automation row is filtered out of the fetch", async () => {
    insertMessage(db, {
      sessionId: "shared",
      userId: "alice",
      project: "alpha",
      role: "user",
      content: "automation prompt",
      fromAutomation: true,
    });
    const realId = insertMessage(db, {
      sessionId: "shared",
      userId: "alice",
      project: "alpha",
      role: "user",
      content: "real prompt",
    });
    const pairs = listActiveUserProjectPairs(db, 10);
    expect(pairs.length).toBe(1);
    expect(pairs[0]!.maxId).toBe(realId);
    const { getUserProjectMessagesAfter } = await import(
      "../../src/memory/messages.ts"
    );
    const fetched = getUserProjectMessagesAfter(db, "alice", "alpha", 0, 50);
    expect(fetched.map((m) => m.content)).toEqual(["real prompt"]);
  });

  test("the seeded `system` user is excluded from both per-project and soul refresh", () => {
    const now = Date.now();
    db.run(
      `INSERT INTO users(id, username, password_hash, role, created_at, updated_at)
       VALUES ('sys', 'system', 'x', 'user', ?, ?)`,
      [now, now],
    );
    insertMessage(db, {
      sessionId: "cli-1",
      userId: "sys",
      project: "alpha",
      role: "user",
      content: "one-shot CLI run",
    });
    insertMessage(db, {
      sessionId: "cli-1",
      userId: "sys",
      project: "alpha",
      role: "assistant",
      content: "ok",
    });
    insertMessage(db, {
      sessionId: "real-1",
      userId: "alice",
      project: "alpha",
      role: "user",
      content: "real user run",
    });

    const pairs = listActiveUserProjectPairs(db, 10);
    expect(pairs.find((p) => p.userId === "sys")).toBeUndefined();
    expect(pairs.find((p) => p.userId === "alice")).toBeDefined();

    const souls = listActiveSoulUsers(db, 10);
    expect(souls.find((u) => u.userId === "sys")).toBeUndefined();
    expect(souls.find((u) => u.userId === "alice")).toBeDefined();
  });
});
