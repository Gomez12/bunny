import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../../src/memory/db.ts";
import {
  createScript,
  deleteScript,
  generateTempName,
  getScript,
  listScripts,
  listScriptVersions,
  promoteScript,
  pruneScriptVersions,
  scriptRelPath,
  updateScript,
  LANGUAGE_TO_EXT,
  EXT_TO_LANGUAGE,
} from "../../src/memory/scripts.ts";
import { restore } from "../../src/memory/trash.ts";

let tmp: string;
let db: Database;
let codeProjectId: number;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "bunny-scripts-"));
  db = await openDb(join(tmp, "test.sqlite"));
  // 'general' project is auto-seeded by openDb
  const cp = db.prepare(`
    INSERT INTO code_projects (project, name, created_at, updated_at)
    VALUES ('general', 'myrepo', 1000, 1000)
    RETURNING id
  `).get() as { id: number };
  codeProjectId = cp.id;
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

test("createScript — regular with name", () => {
  const s = createScript(db, {
    codeProjectId,
    project: "general",
    name: "hello",
    language: "javascript",
  });
  expect(s.name).toBe("hello");
  expect(s.language).toBe("javascript");
  expect(s.isTemp).toBe(false);
  expect(s.content).toBe("");
});

test("createScript — temp without name auto-generates", () => {
  const s = createScript(db, {
    codeProjectId,
    project: "general",
    isTemp: true,
  });
  expect(s.isTemp).toBe(true);
  expect(s.name).toMatch(/^scratch-\d{8}-\d{6}-[a-z0-9]{3}$/);
});

test("createScript — temp with explicit name uses it", () => {
  const s = createScript(db, {
    codeProjectId,
    project: "general",
    name: "mytemp",
    isTemp: true,
  });
  expect(s.name).toBe("mytemp");
});

test("createScript — throws without name for non-temp", () => {
  expect(() =>
    createScript(db, { codeProjectId, project: "general" }),
  ).toThrow("name");
});

test("listScripts — excludes temp by default", () => {
  createScript(db, { codeProjectId, project: "general", name: "regular" });
  createScript(db, { codeProjectId, project: "general", isTemp: true });

  const regular = listScripts(db, codeProjectId);
  expect(regular.length).toBe(1);
  expect(regular[0]!.name).toBe("regular");
});

test("listScripts — includeTemp shows both", () => {
  createScript(db, { codeProjectId, project: "general", name: "regular" });
  createScript(db, { codeProjectId, project: "general", isTemp: true });

  const all = listScripts(db, codeProjectId, { includeTemp: true });
  expect(all.length).toBe(2);
});

test("updateScript — saves content without version by default", () => {
  const s = createScript(db, {
    codeProjectId,
    project: "general",
    name: "s1",
  });
  const updated = updateScript(db, s.id, { content: "console.log(1)" });
  expect(updated?.content).toBe("console.log(1)");

  const versions = listScriptVersions(db, s.id);
  expect(versions.length).toBe(0);
});

test("updateScript — createVersion snapshots old content", () => {
  const s = createScript(db, {
    codeProjectId,
    project: "general",
    name: "s2",
    content: "v1",
  });
  updateScript(db, s.id, { content: "v2" }, { createVersion: true });

  const versions = listScriptVersions(db, s.id);
  expect(versions.length).toBe(1);
  expect(versions[0]!.content).toBe("v1");
});

test("pruneScriptVersions — keeps newest N", () => {
  const s = createScript(db, {
    codeProjectId,
    project: "general",
    name: "sv",
    content: "v0",
  });
  for (let i = 1; i <= 5; i++) {
    updateScript(db, s.id, { content: `v${i}` }, { createVersion: true });
  }
  pruneScriptVersions(db, s.id, 3);
  const versions = listScriptVersions(db, s.id);
  expect(versions.length).toBe(3);
});

test("deleteScript and restore", () => {
  const s = createScript(db, {
    codeProjectId,
    project: "general",
    name: "todel",
  });
  expect(deleteScript(db, s.id, null)).toBe(true);
  expect(getScript(db, s.id)).toBeUndefined();

  const outcome = restore(db, "script", s.id);
  expect(outcome).toBe("ok");
  const restored = getScript(db, s.id);
  expect(restored?.name).toBe("todel");
});

test("promoteScript — clears is_temp", () => {
  const s = createScript(db, {
    codeProjectId,
    project: "general",
    isTemp: true,
  });
  expect(s.isTemp).toBe(true);
  promoteScript(db, s.id);
  const updated = getScript(db, s.id);
  expect(updated?.isTemp).toBe(false);
});

test("scriptRelPath — regular", () => {
  const p = scriptRelPath("myrepo", "hello", "javascript", false);
  expect(p).toBe("code/myrepo/scripts/hello.js");
});

test("scriptRelPath — temp", () => {
  const p = scriptRelPath("myrepo", "scratch", "python", true);
  expect(p).toBe("code/myrepo/scripts/temp/scratch.py");
});

test("generateTempName — matches expected pattern", () => {
  const name = generateTempName();
  expect(name).toMatch(/^scratch-\d{8}-\d{6}-[a-z0-9]{3}$/);
});

test("LANGUAGE_TO_EXT covers all languages", () => {
  expect(LANGUAGE_TO_EXT.javascript).toBe(".js");
  expect(LANGUAGE_TO_EXT.typescript).toBe(".ts");
  expect(LANGUAGE_TO_EXT.csharp).toBe(".cs");
  expect(LANGUAGE_TO_EXT.python).toBe(".py");
  expect(LANGUAGE_TO_EXT.bash).toBe(".sh");
  expect(LANGUAGE_TO_EXT.powershell).toBe(".ps1");
  expect(LANGUAGE_TO_EXT.go).toBe(".go");
  expect(LANGUAGE_TO_EXT.sql).toBe(".sql");
});

test("EXT_TO_LANGUAGE roundtrip", () => {
  for (const [lang, ext] of Object.entries(LANGUAGE_TO_EXT)) {
    expect(EXT_TO_LANGUAGE[ext] as string).toBe(lang);
  }
});
