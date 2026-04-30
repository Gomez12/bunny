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
    setAgentProjectMemoryAuto(db, "researcher", "alpha", "seed", before[0]!.maxId);
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
});
