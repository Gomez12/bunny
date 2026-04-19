import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/memory/db.ts";
import { createProject } from "../../src/memory/projects.ts";
import {
  createDocument,
  deleteDocument,
  getDocument,
  listDocuments,
  saveAsTemplate,
} from "../../src/memory/documents.ts";
import {
  createWhiteboard,
  deleteWhiteboard,
  getWhiteboard,
  listWhiteboards,
} from "../../src/memory/whiteboards.ts";
import {
  createContact,
  createGroup,
  deleteContact,
  getContact,
  listContacts,
  listGroups,
  updateContact,
} from "../../src/memory/contacts.ts";
import {
  createDefinition,
  deleteDefinition,
  getDefinition,
  listDefinitions,
} from "../../src/memory/kb_definitions.ts";
import { hardDelete, listTrash, restore } from "../../src/memory/trash.ts";

let tmp: string;

async function newDb() {
  tmp = mkdtempSync(join(tmpdir(), "bunny-trash-"));
  return openDb(join(tmp, "test.sqlite"));
}

async function setup() {
  const db = await newDb();
  const now = Date.now();
  db.run(
    `INSERT INTO users(id, username, password_hash, role, created_at, updated_at)
     VALUES ('alice', 'alice', 'x', 'admin', ?, ?)`,
    [now, now],
  );
  createProject(db, { name: "alpha", createdBy: "alice" });
  return { db };
}

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("soft-delete hides from list/get", () => {
  test("document disappears after deleteDocument but row still exists", async () => {
    const { db } = await setup();
    const doc = createDocument(db, {
      project: "alpha",
      name: "Plan",
      createdBy: "alice",
    });
    deleteDocument(db, doc.id, "alice");

    expect(getDocument(db, doc.id)).toBeNull();
    expect(listDocuments(db, "alpha")).toHaveLength(0);

    const raw = db
      .prepare(
        `SELECT name, deleted_at, deleted_by FROM documents WHERE id = ?`,
      )
      .get(doc.id) as {
      name: string;
      deleted_at: number | null;
      deleted_by: string | null;
    };
    expect(raw.deleted_at).not.toBeNull();
    expect(raw.deleted_by).toBe("alice");
    expect(raw.name).toBe(`__trash:${doc.id}:Plan`);
    db.close();
  });

  test("whiteboard soft-delete frees the UNIQUE(name) slot", async () => {
    const { db } = await setup();
    const wb = createWhiteboard(db, {
      project: "alpha",
      name: "Board",
      createdBy: "alice",
    });
    deleteWhiteboard(db, wb.id, "alice");

    const fresh = createWhiteboard(db, {
      project: "alpha",
      name: "Board",
      createdBy: "alice",
    });
    expect(fresh.id).not.toBe(wb.id);
    expect(listWhiteboards(db, "alpha")).toHaveLength(1);
    db.close();
  });

  test("contact soft-delete drops translation sidecar rows", async () => {
    const { db } = await setup();
    db.run(`UPDATE projects SET languages = '["en","nl"]' WHERE name = ?`, [
      "alpha",
    ]);
    const contact = createContact(db, {
      project: "alpha",
      name: "Bob",
      notes: "hello",
      createdBy: "alice",
    });
    const before = db
      .prepare(
        `SELECT COUNT(*) AS n FROM contact_translations WHERE contact_id = ?`,
      )
      .get(contact.id) as { n: number };
    expect(before.n).toBeGreaterThan(0);

    deleteContact(db, contact.id, "alice");
    const after = db
      .prepare(
        `SELECT COUNT(*) AS n FROM contact_translations WHERE contact_id = ?`,
      )
      .get(contact.id) as { n: number };
    expect(after.n).toBe(0);
    expect(getContact(db, contact.id)).toBeNull();
    db.close();
  });

  test("kb_definition soft-delete frees UNIQUE(project, term)", async () => {
    const { db } = await setup();
    const def = createDefinition(db, {
      project: "alpha",
      term: "Widget",
      createdBy: "alice",
    });
    deleteDefinition(db, def.id, "alice");
    expect(listDefinitions(db, "alpha").total).toBe(0);
    const fresh = createDefinition(db, {
      project: "alpha",
      term: "Widget",
      createdBy: "alice",
    });
    expect(fresh.id).not.toBe(def.id);
    db.close();
  });
});

describe("listTrash aggregates every kind", () => {
  test("spans documents + whiteboards + contacts + kb_definitions", async () => {
    const { db } = await setup();
    const doc = createDocument(db, {
      project: "alpha",
      name: "Plan",
      createdBy: "alice",
    });
    const wb = createWhiteboard(db, {
      project: "alpha",
      name: "Board",
      createdBy: "alice",
    });
    const contact = createContact(db, {
      project: "alpha",
      name: "Bob",
      createdBy: "alice",
    });
    const def = createDefinition(db, {
      project: "alpha",
      term: "Widget",
      createdBy: "alice",
    });

    deleteDocument(db, doc.id, "alice");
    deleteWhiteboard(db, wb.id, "alice");
    deleteContact(db, contact.id, "alice");
    deleteDefinition(db, def.id, "alice");

    const items = listTrash(db);
    const kinds = items.map((i) => i.kind).sort();
    expect(kinds).toEqual([
      "contact",
      "document",
      "kb_definition",
      "whiteboard",
    ] as const);
    // Names should be the original display names — not the mangled storage form.
    const byKind = new Map(items.map((i) => [i.kind, i]));
    expect(byKind.get("document")?.name).toBe("Plan");
    expect(byKind.get("whiteboard")?.name).toBe("Board");
    expect(byKind.get("contact")?.name).toBe("Bob");
    expect(byKind.get("kb_definition")?.name).toBe("Widget");
    db.close();
  });
});

describe("restore", () => {
  test("restores a document and strips the trash prefix", async () => {
    const { db } = await setup();
    const doc = createDocument(db, {
      project: "alpha",
      name: "Plan",
      createdBy: "alice",
    });
    deleteDocument(db, doc.id, "alice");

    const outcome = restore(db, "document", doc.id);
    expect(outcome).toBe("ok");

    const restored = getDocument(db, doc.id);
    expect(restored).not.toBeNull();
    expect(restored!.name).toBe("Plan");
    expect(listDocuments(db, "alpha")).toHaveLength(1);
    db.close();
  });

  test("restore returns name_conflict when the live slot is taken", async () => {
    const { db } = await setup();
    const doc = createDocument(db, {
      project: "alpha",
      name: "Plan",
      createdBy: "alice",
    });
    deleteDocument(db, doc.id, "alice");
    // Someone else now creates "Plan" in the same project.
    createDocument(db, {
      project: "alpha",
      name: "Plan",
      createdBy: "alice",
    });

    expect(restore(db, "document", doc.id)).toBe("name_conflict");
    // Row stays in the bin.
    expect(listTrash(db).some((i) => i.id === doc.id)).toBe(true);
    db.close();
  });

  test("contacts restore reseeds translation sidecars", async () => {
    const { db } = await setup();
    db.run(
      `UPDATE projects SET languages = '["en","nl","de"]' WHERE name = ?`,
      ["alpha"],
    );
    const contact = createContact(db, {
      project: "alpha",
      name: "Bob",
      notes: "hello",
      createdBy: "alice",
    });
    deleteContact(db, contact.id, "alice");

    expect(restore(db, "contact", contact.id)).toBe("ok");

    const after = db
      .prepare(
        `SELECT COUNT(*) AS n FROM contact_translations WHERE contact_id = ?`,
      )
      .get(contact.id) as { n: number };
    // en is the source, nl + de are translations → 2 pending sidecar rows.
    expect(after.n).toBe(2);
    db.close();
  });
});

describe("hardDelete", () => {
  test("refuses to hard-delete a live row", async () => {
    const { db } = await setup();
    const doc = createDocument(db, {
      project: "alpha",
      name: "Plan",
      createdBy: "alice",
    });
    expect(hardDelete(db, "document", doc.id)).toBe(false);
    expect(getDocument(db, doc.id)).not.toBeNull();
    db.close();
  });

  test("removes the row + cascades translations", async () => {
    const { db } = await setup();
    db.run(`UPDATE projects SET languages = '["en","nl"]' WHERE name = ?`, [
      "alpha",
    ]);
    const doc = createDocument(db, {
      project: "alpha",
      name: "Plan",
      createdBy: "alice",
    });
    deleteDocument(db, doc.id, "alice");
    expect(hardDelete(db, "document", doc.id)).toBe(true);

    const row = db
      .prepare(`SELECT id FROM documents WHERE id = ?`)
      .get(doc.id) as { id: number } | null | undefined;
    expect(row ?? null).toBeNull();
    const trans = db
      .prepare(
        `SELECT COUNT(*) AS n FROM document_translations WHERE document_id = ?`,
      )
      .get(doc.id) as { n: number };
    expect(trans.n).toBe(0);
    db.close();
  });
});

describe("quiet integration points", () => {
  test("saveAsTemplate reuses the original [Template] name after soft-delete", async () => {
    const { db } = await setup();
    const source = createDocument(db, {
      project: "alpha",
      name: "Plan",
      createdBy: "alice",
    });
    const first = saveAsTemplate(db, source.id, "alice");
    expect(first.name).toBe("[Template] Plan");

    deleteDocument(db, first.id, "alice");
    // Previously UNIQUE(project, name) would have forced "[Template] Plan (2)".
    const second = saveAsTemplate(db, source.id, "alice");
    expect(second.name).toBe("[Template] Plan");
    db.close();
  });

  test("listGroups member_count excludes soft-deleted contacts", async () => {
    const { db } = await setup();
    const group = createGroup(db, {
      project: "alpha",
      name: "Team",
      createdBy: "alice",
    });
    const bob = createContact(db, {
      project: "alpha",
      name: "Bob",
      createdBy: "alice",
    });
    const carol = createContact(db, {
      project: "alpha",
      name: "Carol",
      createdBy: "alice",
    });
    updateContact(db, bob.id, { groups: [group.id] });
    updateContact(db, carol.id, { groups: [group.id] });

    expect(
      listGroups(db, "alpha").find((g) => g.id === group.id)?.memberCount,
    ).toBe(2);
    deleteContact(db, bob.id, "alice");
    expect(
      listGroups(db, "alpha").find((g) => g.id === group.id)?.memberCount,
    ).toBe(1);
    db.close();
  });
});
