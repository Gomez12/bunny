/**
 * Phase 2e round-trip smoke tests — code_project / workflow / diagram /
 * script. For scripts the legacy `script_versions` chain stays untouched;
 * this suite only exercises the new universal `entity_versions` chain.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/memory/db.ts";
import { createProject } from "../../src/memory/projects.ts";
import {
  createCodeProject,
  getCodeProject,
  updateCodeProject,
} from "../../src/memory/code_projects.ts";
import {
  createWorkflow,
  getWorkflow,
  updateWorkflow,
} from "../../src/memory/workflows.ts";
import {
  createDiagram,
  getDiagram,
  updateDiagram,
} from "../../src/memory/diagrams.ts";
import {
  createScript,
  getScript,
  updateScript,
} from "../../src/memory/scripts.ts";
import {
  configureVersioning,
  recordVersion,
  restoreVersion,
} from "../../src/memory/versioning.ts";

let tmp: string;

async function setup() {
  tmp = mkdtempSync(join(tmpdir(), "bunny-versioning-2e-"));
  const db = await openDb(join(tmp, "test.sqlite"));
  const now = Date.now();
  db.run(
    `INSERT INTO users(id, username, password_hash, role, created_at, updated_at)
     VALUES ('alice', 'alice', 'x', 'admin', ?, ?)`,
    [now, now],
  );
  createProject(db, { name: "alpha", createdBy: "alice" });
  return db;
}

beforeEach(() => {
  configureVersioning({ debounceMinutes: 0, maxSnapshotBytes: 1_048_576 });
});

afterEach(() => {
  configureVersioning({ debounceMinutes: 5, maxSnapshotBytes: 1_048_576 });
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("code_project versioning", () => {
  test("restoreVersion reverts description + git_ref", async () => {
    const db = await setup();
    const cp = createCodeProject(db, {
      project: "alpha",
      name: "core",
      description: "v1",
      gitUrl: "https://example.com/repo.git",
      gitRef: "main",
      createdBy: "alice",
    });
    recordVersion(db, "code_project", cp.id, "save", "alice");

    updateCodeProject(db, cp.id, { description: "v2", gitRef: "develop" });
    recordVersion(db, "code_project", cp.id, "save", "alice");

    restoreVersion(db, "code_project", cp.id, 1, "alice");
    const restored = getCodeProject(db, cp.id)!;
    expect(restored.description).toBe("v1");
    expect(restored.gitRef).toBe("main");
    db.close();
  });
});

describe("workflow versioning", () => {
  test("restoreVersion reverts name + description (TOML stays on disk)", async () => {
    const db = await setup();
    const wf = createWorkflow(db, {
      project: "alpha",
      slug: "demo",
      name: "Demo v1",
      description: "first",
      tomlSha256: "aaa",
      createdBy: "alice",
    });
    recordVersion(db, "workflow", wf.id, "save", "alice");

    updateWorkflow(db, wf.id, {
      name: "Demo v2",
      description: "second",
      tomlSha256: "bbb",
    });
    recordVersion(db, "workflow", wf.id, "save", "alice");

    restoreVersion(db, "workflow", wf.id, 1, "alice");
    const restored = getWorkflow(db, wf.id)!;
    expect(restored.name).toBe("Demo v1");
    expect(restored.description).toBe("first");
    // Slug is immutable post-create — must round-trip identically.
    expect(restored.slug).toBe("demo");
    db.close();
  });
});

describe("diagram versioning", () => {
  test("restoreVersion reverts content_json + description", async () => {
    const db = await setup();
    const d = createDiagram(db, {
      project: "alpha",
      name: "Architecture",
      diagramType: "custom",
      description: "first",
      contentJson: '{"nodes":[{"id":"a"}],"edges":[]}',
      createdBy: "alice",
    });
    recordVersion(db, "diagram", d.id, "save", "alice");

    updateDiagram(db, d.id, {
      description: "second",
      contentJson: '{"nodes":[{"id":"b"}],"edges":[]}',
    });
    recordVersion(db, "diagram", d.id, "save", "alice");

    restoreVersion(db, "diagram", d.id, 1, "alice");
    const restored = getDiagram(db, d.id)!;
    expect(restored.description).toBe("first");
    expect(restored.contentJson).toBe('{"nodes":[{"id":"a"}],"edges":[]}');
    db.close();
  });
});

describe("script versioning", () => {
  test("restoreVersion reverts content + language (legacy chain untouched)", async () => {
    const db = await setup();
    const cp = createCodeProject(db, {
      project: "alpha",
      name: "core",
      createdBy: "alice",
    });
    const s = createScript(db, {
      codeProjectId: cp.id,
      project: "alpha",
      name: "hello",
      content: "console.log(1)",
      language: "javascript",
      createdBy: "alice",
    });
    recordVersion(db, "script", s.id, "save", "alice");

    updateScript(
      db,
      s.id,
      { content: "console.log(2)", language: "typescript" },
      { createdBy: "alice", createVersion: false },
    );
    recordVersion(db, "script", s.id, "save", "alice");

    restoreVersion(db, "script", s.id, 1, "alice");
    const restored = getScript(db, s.id)!;
    expect(restored.content).toBe("console.log(1)");
    expect(restored.language).toBe("javascript");
    db.close();
  });
});
