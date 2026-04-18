import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/memory/db.ts";
import {
  DEFAULT_PROJECT,
  createProject,
  deleteProject,
  ensureProject,
  getProject,
  getSessionProject,
  listProjects,
  updateProject,
  validateProjectName,
} from "../../src/memory/projects.ts";
import { insertMessage } from "../../src/memory/messages.ts";

let tmp: string;

async function newDb() {
  tmp = mkdtempSync(join(tmpdir(), "bunny-projects-"));
  return openDb(join(tmp, "test.sqlite"));
}

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("validateProjectName", () => {
  test("accepts simple names", () => {
    expect(validateProjectName("general")).toBe("general");
    expect(validateProjectName("Alpha")).toBe("alpha");
    expect(validateProjectName("my-project_1")).toBe("my-project_1");
  });
  test("rejects reserved / empty / path-like names", () => {
    expect(() => validateProjectName("")).toThrow();
    expect(() => validateProjectName(".")).toThrow();
    expect(() => validateProjectName("..")).toThrow();
    expect(() => validateProjectName("node_modules")).toThrow();
    expect(() => validateProjectName("-leading-dash")).toThrow();
    expect(() => validateProjectName("has/slash")).toThrow();
    expect(() => validateProjectName("has space")).toThrow();
  });
});

describe("project registry", () => {
  test("auto-seeds the 'general' project on open", async () => {
    const db = await newDb();
    const p = getProject(db, DEFAULT_PROJECT);
    expect(p).not.toBeNull();
    expect(p!.visibility).toBe("public");
    db.close();
  });

  test("create + get + list + update", async () => {
    const db = await newDb();
    createProject(db, { name: "alpha", description: "first" });
    createProject(db, { name: "beta", visibility: "private" });
    const list = listProjects(db);
    expect(list.map((p) => p.name).sort()).toEqual([
      "alpha",
      "beta",
      "general",
    ]);
    const updated = updateProject(db, "alpha", { description: "new desc" });
    expect(updated.description).toBe("new desc");
    db.close();
  });

  test("deleteProject forbids removing 'general'", async () => {
    const db = await newDb();
    expect(() => deleteProject(db, DEFAULT_PROJECT)).toThrow();
    db.close();
  });

  test("duplicate create throws", async () => {
    const db = await newDb();
    createProject(db, { name: "dup" });
    expect(() => createProject(db, { name: "dup" })).toThrow();
    db.close();
  });
});

describe("getSessionProject", () => {
  test("returns null for unknown (empty) sessions", async () => {
    const db = await newDb();
    expect(getSessionProject(db, "unknown")).toBeNull();
    db.close();
  });

  test("derives from any message in the session", async () => {
    const db = await newDb();
    createProject(db, { name: "alpha" });
    insertMessage(db, {
      sessionId: "s1",
      role: "user",
      content: "hi",
      project: "alpha",
    });
    expect(getSessionProject(db, "s1")).toBe("alpha");
    db.close();
  });

  test("legacy NULL-project rows read back as 'general'", async () => {
    const db = await newDb();
    // Force NULL using raw SQL to mirror a pre-migration row.
    const now = Date.now();
    db.run(
      `INSERT INTO messages (session_id, ts, role, channel, content, project)
       VALUES ('legacy', ?, 'user', 'content', 'hi', NULL)`,
      [now],
    );
    expect(getSessionProject(db, "legacy")).toBe(DEFAULT_PROJECT);
    db.close();
  });
});

describe("ensureProject", () => {
  test("creates missing projects and returns existing ones", async () => {
    const db = await newDb();
    const a = ensureProject(db, "alpha");
    expect(a.name).toBe("alpha");
    const again = ensureProject(db, "alpha");
    expect(again.name).toBe("alpha");
    db.close();
  });
});
