import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/memory/db";
import type { Database } from "bun:sqlite";
import {
  parseProjectUiPrefs,
  validateProjectUiPrefsPatch,
  getUserProjectPrefs,
  setUserProjectPrefs,
} from "../../src/memory/user_project_prefs";
import { createUser } from "../../src/auth/users";

let db: Database;

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), "bunny-proj-prefs-test-"));
  db = await openDb(join(dir, "test.db"));
});

describe("parseProjectUiPrefs", () => {
  test("returns empty object for empty JSON", () => {
    expect(parseProjectUiPrefs("{}")).toEqual({});
  });

  test("parses numeric IDs", () => {
    const raw = JSON.stringify({ activeCodeProjectId: 5, activeDiagramId: 12 });
    expect(parseProjectUiPrefs(raw)).toEqual({ activeCodeProjectId: 5, activeDiagramId: 12 });
  });

  test("parses hiddenTopicIds as number array", () => {
    const raw = JSON.stringify({ hiddenTopicIds: [1, 2, 3] });
    expect(parseProjectUiPrefs(raw)).toEqual({ hiddenTopicIds: [1, 2, 3] });
  });

  test("ignores hiddenTopicIds with non-number elements", () => {
    const raw = JSON.stringify({ hiddenTopicIds: [1, "x"] });
    expect(parseProjectUiPrefs(raw)).toEqual({});
  });

  test("returns empty for corrupt JSON", () => {
    expect(parseProjectUiPrefs("not-json")).toEqual({});
  });
});

describe("validateProjectUiPrefsPatch", () => {
  test("rejects non-object input", () => {
    expect(() => validateProjectUiPrefsPatch("string")).toThrow("prefs must be an object");
  });

  test("rejects unknown keys", () => {
    expect(() => validateProjectUiPrefsPatch({ foo: 1 })).toThrow("unknown pref keys");
  });

  test("rejects non-numeric activeCodeProjectId", () => {
    expect(() => validateProjectUiPrefsPatch({ activeCodeProjectId: "str" })).toThrow(
      "activeCodeProjectId must be a number or null",
    );
  });

  test("rejects non-number array for hiddenTopicIds", () => {
    expect(() => validateProjectUiPrefsPatch({ hiddenTopicIds: ["a"] })).toThrow(
      "hiddenTopicIds must be an array of numbers",
    );
  });

  test("accepts null to clear a field", () => {
    const result = validateProjectUiPrefsPatch({ activeCodeProjectId: null });
    expect(result).toEqual({});
  });

  test("accepts valid partial patch", () => {
    const result = validateProjectUiPrefsPatch({
      activeWorkflowId: 7,
      hiddenTopicIds: [1, 2],
    });
    expect(result).toEqual({ activeWorkflowId: 7, hiddenTopicIds: [1, 2] });
  });
});

describe("getUserProjectPrefs / setUserProjectPrefs", () => {
  test("returns empty prefs for new (user, project) pair", async () => {
    const user = await createUser(db, { username: "alice", password: "pw" });
    expect(getUserProjectPrefs(db, user.id, "general")).toEqual({});
  });

  test("upserts idempotently", async () => {
    const user = await createUser(db, { username: "bob", password: "pw" });
    setUserProjectPrefs(db, user.id, "general", { activeWorkflowId: 3 });
    setUserProjectPrefs(db, user.id, "general", { activeWorkflowId: 3 });
    expect(getUserProjectPrefs(db, user.id, "general")).toEqual({ activeWorkflowId: 3 });
  });

  test("setUserProjectPrefs merges patch with existing prefs", async () => {
    const user = await createUser(db, { username: "carol", password: "pw" });
    setUserProjectPrefs(db, user.id, "general", { activeDiagramId: 1 });
    const after = setUserProjectPrefs(db, user.id, "general", { activeWorkflowId: 5 });
    expect(after).toEqual({ activeDiagramId: 1, activeWorkflowId: 5 });
  });

  test("different projects have independent prefs", async () => {
    const user = await createUser(db, { username: "dave", password: "pw" });
    // "general" is auto-seeded; create "work" explicitly.
    const now = Date.now();
    db.run(
      `INSERT OR IGNORE INTO projects(name, description, visibility, created_by, created_at, updated_at)
       VALUES ('work', 'Work project', 'public', NULL, ?, ?)`,
      [now, now],
    );
    setUserProjectPrefs(db, user.id, "general", { activeWorkflowId: 1 });
    setUserProjectPrefs(db, user.id, "work", { activeWorkflowId: 2 });
    expect(getUserProjectPrefs(db, user.id, "general")).toEqual({ activeWorkflowId: 1 });
    expect(getUserProjectPrefs(db, user.id, "work")).toEqual({ activeWorkflowId: 2 });
  });

  test("hiddenTopicIds stored and retrieved as number array", async () => {
    const user = await createUser(db, { username: "eve", password: "pw" });
    const after = setUserProjectPrefs(db, user.id, "general", { hiddenTopicIds: [10, 20] });
    expect(after.hiddenTopicIds).toEqual([10, 20]);
    expect(getUserProjectPrefs(db, user.id, "general").hiddenTopicIds).toEqual([10, 20]);
  });
});
