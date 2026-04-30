import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../../src/memory/db.ts";
import { createProject } from "../../src/memory/projects.ts";
import {
  MEMORY_FIELD_CHAR_LIMIT,
  bumpUserProjectMemoryWatermark,
  claimUserProjectMemoryForRefresh,
  ensureUserProjectMemory,
  getUserProjectMemory,
  listUserProjectMemoryRefreshCandidates,
  releaseStuckUserProjectMemory,
  setUserProjectMemoryAuto,
  setUserProjectMemoryError,
  setUserProjectMemoryManual,
} from "../../src/memory/user_project_memory.ts";

let tmp: string;
let db: Database;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "bunny-upm-"));
  db = await openDb(join(tmp, "db.sqlite"));
  const now = Date.now();
  db.run(
    `INSERT INTO users(id, username, password_hash, role, created_at, updated_at)
     VALUES ('u1', 'alice', 'x', 'user', ?, ?)`,
    [now, now],
  );
  createProject(db, { name: "alpha", createdBy: "u1" });
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("user_project_memory", () => {
  test("ensure creates an idle row with empty memory + zero watermark", () => {
    const row = ensureUserProjectMemory(db, "u1", "alpha");
    expect(row.memory).toBe("");
    expect(row.status).toBe("idle");
    expect(row.watermarkMessageId).toBe(0);
    expect(row.refreshedAt).toBeNull();
  });

  test("ensure is idempotent on second call", () => {
    const a = ensureUserProjectMemory(db, "u1", "alpha");
    const b = ensureUserProjectMemory(db, "u1", "alpha");
    expect(a.createdAt).toBe(b.createdAt);
  });

  test("manual edit stamps manual_edited_at and persists body", () => {
    setUserProjectMemoryManual(db, "u1", "alpha", "user prefers terse answers");
    const row = getUserProjectMemory(db, "u1", "alpha")!;
    expect(row.memory).toBe("user prefers terse answers");
    expect(row.manualEditedAt).not.toBeNull();
  });

  test("manual edit rejects bodies over the 4k cap", () => {
    expect(() =>
      setUserProjectMemoryManual(db, "u1", "alpha", "x".repeat(4001)),
    ).toThrow();
  });

  test("auto edit truncates at the cap and bumps the watermark", () => {
    ensureUserProjectMemory(db, "u1", "alpha");
    setUserProjectMemoryAuto(db, "u1", "alpha", "x".repeat(5000), 42);
    const row = getUserProjectMemory(db, "u1", "alpha")!;
    expect(row.memory.length).toBe(MEMORY_FIELD_CHAR_LIMIT);
    expect(row.watermarkMessageId).toBe(42);
    expect(row.status).toBe("idle");
    expect(row.refreshedAt).not.toBeNull();
  });

  test("claim returns false when another tick already holds the lock", () => {
    ensureUserProjectMemory(db, "u1", "alpha");
    expect(claimUserProjectMemoryForRefresh(db, "u1", "alpha")).toBe(true);
    expect(claimUserProjectMemoryForRefresh(db, "u1", "alpha")).toBe(false);
  });

  test("setError returns the row to a queryable state with error populated", () => {
    ensureUserProjectMemory(db, "u1", "alpha");
    claimUserProjectMemoryForRefresh(db, "u1", "alpha");
    setUserProjectMemoryError(db, "u1", "alpha", "boom");
    const row = getUserProjectMemory(db, "u1", "alpha")!;
    expect(row.status).toBe("error");
    expect(row.error).toBe("boom");
    expect(row.refreshingAt).toBeNull();
  });

  test("releaseStuck flips refreshing rows older than threshold back to idle", () => {
    ensureUserProjectMemory(db, "u1", "alpha");
    claimUserProjectMemoryForRefresh(db, "u1", "alpha", 1_000);
    // Older than the threshold: release should reclaim it.
    const reset = releaseStuckUserProjectMemory(db, 30_000, 100_000);
    expect(reset).toEqual([{ userId: "u1", project: "alpha" }]);
    const row = getUserProjectMemory(db, "u1", "alpha")!;
    expect(row.status).toBe("idle");
  });

  test("releaseStuck leaves recent refreshing rows alone", () => {
    ensureUserProjectMemory(db, "u1", "alpha");
    claimUserProjectMemoryForRefresh(db, "u1", "alpha", 100_000);
    const reset = releaseStuckUserProjectMemory(db, 30_000, 110_000);
    expect(reset).toEqual([]);
  });

  test("bumpWatermark advances watermark without touching the body", () => {
    setUserProjectMemoryManual(db, "u1", "alpha", "seed");
    bumpUserProjectMemoryWatermark(db, "u1", "alpha", 17);
    const row = getUserProjectMemory(db, "u1", "alpha")!;
    expect(row.memory).toBe("seed");
    expect(row.watermarkMessageId).toBe(17);
  });

  test("listRefreshCandidates returns idle rows oldest-refreshed-first", () => {
    ensureUserProjectMemory(db, "u1", "alpha");
    setUserProjectMemoryAuto(db, "u1", "alpha", "first", 1);
    // Second pair newer.
    db.run(
      `INSERT INTO users(id, username, password_hash, role, created_at, updated_at)
       VALUES ('u2', 'bob', 'x', 'user', ?, ?)`,
      [Date.now(), Date.now()],
    );
    createProject(db, { name: "beta", createdBy: "u2" });
    ensureUserProjectMemory(db, "u2", "beta");
    setUserProjectMemoryAuto(db, "u2", "beta", "second", 1);
    const rows = listUserProjectMemoryRefreshCandidates(db, 5);
    expect(rows.length).toBe(2);
    expect(rows[0]!.refreshedAt).toBeLessThanOrEqual(rows[1]!.refreshedAt!);
  });
});
