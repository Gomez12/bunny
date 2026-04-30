import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../../src/memory/db.ts";
import { createProject } from "../../src/memory/projects.ts";
import { createAgent, linkAgentToProject } from "../../src/memory/agents.ts";
import {
  bumpAgentProjectMemoryWatermark,
  claimAgentProjectMemoryForRefresh,
  ensureAgentProjectMemory,
  getAgentProjectMemory,
  releaseStuckAgentProjectMemory,
  setAgentProjectMemoryAuto,
  setAgentProjectMemoryError,
  setAgentProjectMemoryManual,
} from "../../src/memory/agent_project_memory.ts";
import { MEMORY_FIELD_CHAR_LIMIT } from "../../src/memory/user_project_memory.ts";

let tmp: string;
let db: Database;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "bunny-apm-"));
  db = await openDb(join(tmp, "db.sqlite"));
  const now = Date.now();
  db.run(
    `INSERT INTO users(id, username, password_hash, role, created_at, updated_at)
     VALUES ('u1', 'alice', 'x', 'user', ?, ?)`,
    [now, now],
  );
  createProject(db, { name: "alpha", createdBy: "u1" });
  createAgent(db, {
    name: "researcher",
    description: "Research agent",
    visibility: "public",
    createdBy: "u1",
  });
  linkAgentToProject(db, "alpha", "researcher");
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("agent_project_memory", () => {
  test("ensure creates an idle row", () => {
    const row = ensureAgentProjectMemory(db, "researcher", "alpha");
    expect(row.memory).toBe("");
    expect(row.status).toBe("idle");
    expect(row.watermarkMessageId).toBe(0);
  });

  test("manual edit persists the body and stamps manual_edited_at", () => {
    setAgentProjectMemoryManual(
      db,
      "researcher",
      "alpha",
      "uses dutch language by default",
    );
    const row = getAgentProjectMemory(db, "researcher", "alpha")!;
    expect(row.memory).toBe("uses dutch language by default");
    expect(row.manualEditedAt).not.toBeNull();
  });

  test("manual edit rejects bodies over the cap", () => {
    expect(() =>
      setAgentProjectMemoryManual(db, "researcher", "alpha", "x".repeat(4001)),
    ).toThrow();
  });

  test("auto edit truncates and advances the watermark", () => {
    ensureAgentProjectMemory(db, "researcher", "alpha");
    setAgentProjectMemoryAuto(db, "researcher", "alpha", "x".repeat(5000), 99);
    const row = getAgentProjectMemory(db, "researcher", "alpha")!;
    expect(row.memory.length).toBe(MEMORY_FIELD_CHAR_LIMIT);
    expect(row.watermarkMessageId).toBe(99);
    expect(row.status).toBe("idle");
  });

  test("claim is exclusive across concurrent ticks", () => {
    ensureAgentProjectMemory(db, "researcher", "alpha");
    expect(claimAgentProjectMemoryForRefresh(db, "researcher", "alpha")).toBe(
      true,
    );
    expect(claimAgentProjectMemoryForRefresh(db, "researcher", "alpha")).toBe(
      false,
    );
  });

  test("setError flips status to error and clears refreshing_at", () => {
    ensureAgentProjectMemory(db, "researcher", "alpha");
    claimAgentProjectMemoryForRefresh(db, "researcher", "alpha");
    setAgentProjectMemoryError(db, "researcher", "alpha", "model timeout");
    const row = getAgentProjectMemory(db, "researcher", "alpha")!;
    expect(row.status).toBe("error");
    expect(row.error).toBe("model timeout");
    expect(row.refreshingAt).toBeNull();
  });

  test("releaseStuck reclaims long-stuck refreshing rows", () => {
    ensureAgentProjectMemory(db, "researcher", "alpha");
    claimAgentProjectMemoryForRefresh(db, "researcher", "alpha", 1_000);
    const reset = releaseStuckAgentProjectMemory(db, 30_000, 100_000);
    expect(reset).toEqual([{ agent: "researcher", project: "alpha" }]);
  });

  test("bumpWatermark advances without changing memory", () => {
    setAgentProjectMemoryManual(db, "researcher", "alpha", "seed");
    bumpAgentProjectMemoryWatermark(db, "researcher", "alpha", 33);
    const row = getAgentProjectMemory(db, "researcher", "alpha")!;
    expect(row.memory).toBe("seed");
    expect(row.watermarkMessageId).toBe(33);
  });
});
