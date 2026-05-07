import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/memory/db.ts";
import { createProject } from "../../src/memory/projects.ts";
import {
  createDiagram,
  deleteDiagram,
  getDiagram,
  listDiagrams,
  updateDiagram,
} from "../../src/memory/diagrams.ts";

let tmp: string;

async function setup() {
  tmp = mkdtempSync(join(tmpdir(), "bunny-diagrams-"));
  const db = await openDb(join(tmp, "test.sqlite"));
  const now = Date.now();
  db.run(
    `INSERT INTO users(id, username, password_hash, role, created_at, updated_at)
     VALUES ('owner', 'owner', 'x', 'admin', ?, ?)`,
    [now, now],
  );
  createProject(db, { name: "proj", createdBy: "owner" });
  return { db };
}

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("listDiagrams", () => {
  test("returns empty list initially", async () => {
    const { db } = await setup();
    expect(listDiagrams(db, "proj")).toEqual([]);
    db.close();
  });
});

describe("createDiagram", () => {
  test("creates a diagram with defaults", async () => {
    const { db } = await setup();
    const d = createDiagram(db, { project: "proj", name: "My Diagram", createdBy: "owner" });
    expect(d.id).toBeGreaterThan(0);
    expect(d.name).toBe("My Diagram");
    expect(d.diagramType).toBe("custom");
    expect(d.description).toBe("");
    expect(d.contentJson).toBe('{"nodes":[],"edges":[]}');
    expect(d.project).toBe("proj");
    db.close();
  });

  test("creates a diagram with explicit type and description", async () => {
    const { db } = await setup();
    const d = createDiagram(db, {
      project: "proj",
      name: "Network",
      diagramType: "network",
      description: "Office network",
      createdBy: "owner",
    });
    expect(d.diagramType).toBe("network");
    expect(d.description).toBe("Office network");
    db.close();
  });

  test("rejects empty name", async () => {
    const { db } = await setup();
    expect(() => createDiagram(db, { project: "proj", name: "  ", createdBy: "owner" })).toThrow();
    db.close();
  });

  test("enforces unique name per project", async () => {
    const { db } = await setup();
    createDiagram(db, { project: "proj", name: "Same", createdBy: "owner" });
    expect(() => createDiagram(db, { project: "proj", name: "Same", createdBy: "owner" })).toThrow();
    db.close();
  });
});

describe("getDiagram", () => {
  test("returns the diagram by id", async () => {
    const { db } = await setup();
    const d = createDiagram(db, { project: "proj", name: "Test", createdBy: "owner" });
    const fetched = getDiagram(db, d.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.name).toBe("Test");
    db.close();
  });

  test("returns null for unknown id", async () => {
    const { db } = await setup();
    expect(getDiagram(db, 9999)).toBeNull();
    db.close();
  });
});

describe("updateDiagram", () => {
  test("updates name and contentJson", async () => {
    const { db } = await setup();
    const d = createDiagram(db, { project: "proj", name: "Old", createdBy: "owner" });
    const content = '{"nodes":[{"id":"n1"}],"edges":[]}';
    const updated = updateDiagram(db, d.id, { name: "New", contentJson: content });
    expect(updated.name).toBe("New");
    expect(updated.contentJson).toBe(content);
    db.close();
  });

  test("updates thumbnail", async () => {
    const { db } = await setup();
    const d = createDiagram(db, { project: "proj", name: "T", createdBy: "owner" });
    const updated = updateDiagram(db, d.id, { thumbnail: "data:image/png;base64,abc" });
    expect(updated.thumbnail).toBe("data:image/png;base64,abc");
    db.close();
  });
});

describe("deleteDiagram", () => {
  test("soft-deletes: getDiagram returns null, row still exists with deleted_at", async () => {
    const { db } = await setup();
    const d = createDiagram(db, { project: "proj", name: "Del", createdBy: "owner" });
    deleteDiagram(db, d.id, "owner");
    expect(getDiagram(db, d.id)).toBeNull();
    const row = db.prepare("SELECT deleted_at FROM diagrams WHERE id = ?").get(d.id) as { deleted_at: number | null } | undefined;
    expect(row).not.toBeUndefined();
    expect(row!.deleted_at).not.toBeNull();
    db.close();
  });

  test("deleted diagram not in listDiagrams", async () => {
    const { db } = await setup();
    const d = createDiagram(db, { project: "proj", name: "Gone", createdBy: "owner" });
    deleteDiagram(db, d.id, "owner");
    expect(listDiagrams(db, "proj")).toEqual([]);
    db.close();
  });
});
