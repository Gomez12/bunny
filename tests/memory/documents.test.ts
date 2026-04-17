import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/memory/db.ts";
import { createProject } from "../../src/memory/projects.ts";
import {
  canEditDocument,
  createDocument,
  deleteDocument,
  getDocument,
  listDocuments,
  saveAsTemplate,
  updateDocument,
} from "../../src/memory/documents.ts";
import type { User } from "../../src/auth/users.ts";

let tmp: string;

async function newDb() {
  tmp = mkdtempSync(join(tmpdir(), "bunny-documents-"));
  return openDb(join(tmp, "test.sqlite"));
}

async function setup() {
  const db = await newDb();
  const now = Date.now();
  db.run(
    `INSERT INTO users(id, username, password_hash, role, created_at, updated_at)
     VALUES ('owner', 'owner', 'x', 'admin', ?, ?)`,
    [now, now],
  );
  db.run(
    `INSERT INTO users(id, username, password_hash, role, created_at, updated_at)
     VALUES ('other', 'other', 'x', 'user', ?, ?)`,
    [now, now],
  );
  createProject(db, { name: "alpha", createdBy: "owner" });
  createProject(db, { name: "beta", createdBy: "owner" });
  return { db };
}

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("createDocument", () => {
  test("creates a document with defaults", async () => {
    const { db } = await setup();
    const doc = createDocument(db, { project: "alpha", name: "Notes", createdBy: "owner" });
    expect(doc.id).toBeGreaterThan(0);
    expect(doc.project).toBe("alpha");
    expect(doc.name).toBe("Notes");
    expect(doc.contentMd).toBe("");
    expect(doc.thumbnail).toBeNull();
    expect(doc.createdBy).toBe("owner");
    db.close();
  });

  test("creates a document with initial content", async () => {
    const { db } = await setup();
    const doc = createDocument(db, {
      project: "alpha",
      name: "README",
      contentMd: "# Hello\n\nWorld",
      createdBy: "owner",
    });
    expect(doc.contentMd).toBe("# Hello\n\nWorld");
    db.close();
  });

  test("requires non-empty name", async () => {
    const { db } = await setup();
    expect(() =>
      createDocument(db, { project: "alpha", name: "  ", createdBy: "owner" }),
    ).toThrow("document name is required");
    db.close();
  });

  test("enforces unique (project, name)", async () => {
    const { db } = await setup();
    createDocument(db, { project: "alpha", name: "Notes", createdBy: "owner" });
    expect(() =>
      createDocument(db, { project: "alpha", name: "Notes", createdBy: "owner" }),
    ).toThrow();
    db.close();
  });

  test("allows same name in different projects", async () => {
    const { db } = await setup();
    const a = createDocument(db, { project: "alpha", name: "Notes", createdBy: "owner" });
    const b = createDocument(db, { project: "beta", name: "Notes", createdBy: "owner" });
    expect(a.id).not.toBe(b.id);
    db.close();
  });
});

describe("listDocuments", () => {
  test("returns summaries scoped to project", async () => {
    const { db } = await setup();
    createDocument(db, { project: "alpha", name: "A", createdBy: "owner" });
    createDocument(db, { project: "alpha", name: "B", createdBy: "owner" });
    createDocument(db, { project: "beta", name: "C", createdBy: "owner" });
    const list = listDocuments(db, "alpha");
    expect(list).toHaveLength(2);
    expect(list.map((d) => d.name).sort()).toEqual(["A", "B"]);
    expect(list[0]).not.toHaveProperty("contentMd");
    db.close();
  });

  test("returns empty for project with no documents", async () => {
    const { db } = await setup();
    expect(listDocuments(db, "alpha")).toHaveLength(0);
    db.close();
  });
});

describe("getDocument", () => {
  test("returns full document with content", async () => {
    const { db } = await setup();
    const created = createDocument(db, {
      project: "alpha",
      name: "X",
      contentMd: "# Test\n\nContent here",
      createdBy: "owner",
    });
    const doc = getDocument(db, created.id);
    expect(doc).not.toBeNull();
    expect(doc!.contentMd).toBe("# Test\n\nContent here");
    db.close();
  });

  test("returns null for missing id", async () => {
    const { db } = await setup();
    expect(getDocument(db, 999)).toBeNull();
    db.close();
  });
});

describe("updateDocument", () => {
  test("partial update preserves unchanged fields", async () => {
    const { db } = await setup();
    const doc = createDocument(db, {
      project: "alpha",
      name: "Orig",
      contentMd: "hello",
      createdBy: "owner",
    });
    const updated = updateDocument(db, doc.id, { name: "Renamed" });
    expect(updated.name).toBe("Renamed");
    expect(updated.contentMd).toBe("hello");
    db.close();
  });

  test("updates content and thumbnail", async () => {
    const { db } = await setup();
    const doc = createDocument(db, { project: "alpha", name: "X", createdBy: "owner" });
    const updated = updateDocument(db, doc.id, {
      contentMd: "# New content",
      thumbnail: "data:image/png;base64,abc",
    });
    expect(updated.contentMd).toBe("# New content");
    expect(updated.thumbnail).toBe("data:image/png;base64,abc");
    db.close();
  });

  test("throws for missing document", async () => {
    const { db } = await setup();
    expect(() => updateDocument(db, 999, { name: "X" })).toThrow("document 999 not found");
    db.close();
  });

  test("rejects empty name", async () => {
    const { db } = await setup();
    const doc = createDocument(db, { project: "alpha", name: "X", createdBy: "owner" });
    expect(() => updateDocument(db, doc.id, { name: "  " })).toThrow("document name is required");
    db.close();
  });
});

describe("deleteDocument", () => {
  test("removes document", async () => {
    const { db } = await setup();
    const doc = createDocument(db, { project: "alpha", name: "X", createdBy: "owner" });
    deleteDocument(db, doc.id);
    expect(getDocument(db, doc.id)).toBeNull();
    db.close();
  });
});

describe("canEditDocument", () => {
  test("admin can always edit", async () => {
    const { db } = await setup();
    const doc = createDocument(db, { project: "alpha", name: "X", createdBy: "other" });
    const project = { name: "alpha", createdBy: "other" } as any;
    const admin: User = { id: "owner", username: "owner", role: "admin" } as any;
    expect(canEditDocument(admin, doc, project)).toBe(true);
    db.close();
  });

  test("project owner can edit", async () => {
    const { db } = await setup();
    const doc = createDocument(db, { project: "alpha", name: "X", createdBy: "other" });
    const project = { name: "alpha", createdBy: "owner" } as any;
    const user: User = { id: "owner", username: "owner", role: "user" } as any;
    expect(canEditDocument(user, doc, project)).toBe(true);
    db.close();
  });

  test("document creator can edit", async () => {
    const { db } = await setup();
    const doc = createDocument(db, { project: "alpha", name: "X", createdBy: "other" });
    const project = { name: "alpha", createdBy: "someone-else" } as any;
    const user: User = { id: "other", username: "other", role: "user" } as any;
    expect(canEditDocument(user, doc, project)).toBe(true);
    db.close();
  });

  test("random user cannot edit", async () => {
    const { db } = await setup();
    const doc = createDocument(db, { project: "alpha", name: "X", createdBy: "owner" });
    const project = { name: "alpha", createdBy: "owner" } as any;
    const user: User = { id: "random", username: "random", role: "user" } as any;
    expect(canEditDocument(user, doc, project)).toBe(false);
    db.close();
  });
});

describe("templates", () => {
  test("createDocument with isTemplate", async () => {
    const { db } = await setup();
    const doc = createDocument(db, {
      project: "alpha",
      name: "My Template",
      contentMd: "# Template\n\nContent here",
      isTemplate: true,
      createdBy: "owner",
    });
    expect(doc.isTemplate).toBe(true);
    expect(doc.contentMd).toBe("# Template\n\nContent here");
    db.close();
  });

  test("listDocuments filters by isTemplate", async () => {
    const { db } = await setup();
    createDocument(db, { project: "alpha", name: "Doc A", createdBy: "owner" });
    createDocument(db, { project: "alpha", name: "Tpl B", isTemplate: true, createdBy: "owner" });
    createDocument(db, { project: "alpha", name: "Doc C", createdBy: "owner" });

    const docs = listDocuments(db, "alpha");
    expect(docs).toHaveLength(2);
    expect(docs.every((d) => !d.isTemplate)).toBe(true);

    const tpls = listDocuments(db, "alpha", { isTemplate: true });
    expect(tpls).toHaveLength(1);
    expect(tpls[0]!.name).toBe("Tpl B");
    expect(tpls[0]!.isTemplate).toBe(true);
    db.close();
  });

  test("saveAsTemplate creates a template copy", async () => {
    const { db } = await setup();
    const doc = createDocument(db, {
      project: "alpha",
      name: "My Report",
      contentMd: "# Report\n\nBody text",
      createdBy: "owner",
    });
    const tpl = saveAsTemplate(db, doc.id, "owner");
    expect(tpl.isTemplate).toBe(true);
    expect(tpl.name).toBe("[Template] My Report");
    expect(tpl.contentMd).toBe("# Report\n\nBody text");
    expect(tpl.id).not.toBe(doc.id);
    db.close();
  });

  test("saveAsTemplate deduplicates names", async () => {
    const { db } = await setup();
    const doc = createDocument(db, {
      project: "alpha",
      name: "Spec",
      contentMd: "content",
      createdBy: "owner",
    });
    const t1 = saveAsTemplate(db, doc.id, "owner");
    expect(t1.name).toBe("[Template] Spec");
    const t2 = saveAsTemplate(db, doc.id, "owner");
    expect(t2.name).toBe("[Template] Spec (2)");
    db.close();
  });

  test("saveAsTemplate throws for missing document", async () => {
    const { db } = await setup();
    expect(() => saveAsTemplate(db, 999, "owner")).toThrow("document 999 not found");
    db.close();
  });
});
