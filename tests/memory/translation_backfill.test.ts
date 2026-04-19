import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/memory/db.ts";
import { createProject, updateProject } from "../../src/memory/projects.ts";
import {
  createDefinition,
  deleteDefinition,
} from "../../src/memory/kb_definitions.ts";
import { createDocument } from "../../src/memory/documents.ts";
import { createContact } from "../../src/memory/contacts.ts";
import {
  backfillAllTranslationSlots,
  backfillTranslationSlotsForProject,
} from "../../src/memory/translatable.ts";

let tmp: string;

async function newDb() {
  tmp = mkdtempSync(join(tmpdir(), "bunny-backfill-"));
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
  return { db };
}

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("updateProject backfills new languages", () => {
  test("adding a language creates pending sidecars for every existing entity", async () => {
    const { db } = await setup();
    createProject(db, {
      name: "alpha",
      languages: ["en", "nl"],
      defaultLanguage: "en",
      createdBy: "alice",
    });

    const def = createDefinition(db, {
      project: "alpha",
      term: "Widget",
      createdBy: "alice",
    });
    const doc = createDocument(db, {
      project: "alpha",
      name: "Notes",
      createdBy: "alice",
    });
    const contact = createContact(db, {
      project: "alpha",
      name: "Bob",
      createdBy: "alice",
    });

    // Before expansion: only NL sidecars exist.
    const defBefore = db
      .prepare(
        `SELECT lang FROM kb_definition_translations WHERE definition_id = ? ORDER BY lang`,
      )
      .all(def.id) as { lang: string }[];
    expect(defBefore.map((r) => r.lang)).toEqual(["nl"]);

    updateProject(db, "alpha", { languages: ["en", "nl", "fr", "de"] });

    const defAfter = db
      .prepare(
        `SELECT lang, status FROM kb_definition_translations
          WHERE definition_id = ? ORDER BY lang`,
      )
      .all(def.id) as { lang: string; status: string }[];
    expect(defAfter.map((r) => r.lang)).toEqual(["de", "fr", "nl"]);
    // New ones land as pending so the scheduler picks them up.
    expect(defAfter.find((r) => r.lang === "fr")?.status).toBe("pending");
    expect(defAfter.find((r) => r.lang === "de")?.status).toBe("pending");

    const docAfter = db
      .prepare(
        `SELECT lang FROM document_translations WHERE document_id = ? ORDER BY lang`,
      )
      .all(doc.id) as { lang: string }[];
    expect(docAfter.map((r) => r.lang)).toEqual(["de", "fr", "nl"]);

    const contactAfter = db
      .prepare(
        `SELECT lang FROM contact_translations WHERE contact_id = ? ORDER BY lang`,
      )
      .all(contact.id) as { lang: string }[];
    expect(contactAfter.map((r) => r.lang)).toEqual(["de", "fr", "nl"]);
    db.close();
  });

  test("no-op when the languages list is unchanged", async () => {
    const { db } = await setup();
    createProject(db, {
      name: "alpha",
      languages: ["en", "nl"],
      defaultLanguage: "en",
      createdBy: "alice",
    });
    const def = createDefinition(db, {
      project: "alpha",
      term: "Widget",
      createdBy: "alice",
    });
    updateProject(db, "alpha", { description: "tweaked" });
    const rows = db
      .prepare(
        `SELECT lang FROM kb_definition_translations WHERE definition_id = ?`,
      )
      .all(def.id) as { lang: string }[];
    expect(rows.map((r) => r.lang)).toEqual(["nl"]);
    db.close();
  });

  test("soft-deleted entities are skipped during backfill", async () => {
    const { db } = await setup();
    createProject(db, {
      name: "alpha",
      languages: ["en"],
      defaultLanguage: "en",
      createdBy: "alice",
    });
    const def = createDefinition(db, {
      project: "alpha",
      term: "Widget",
      createdBy: "alice",
    });
    deleteDefinition(db, def.id, "alice");

    updateProject(db, "alpha", { languages: ["en", "nl"] });

    const rows = db
      .prepare(
        `SELECT lang FROM kb_definition_translations WHERE definition_id = ?`,
      )
      .all(def.id) as { lang: string }[];
    // softDelete dropped sidecars; backfill must not resurrect them.
    expect(rows).toHaveLength(0);
    db.close();
  });
});

describe("backfillAllTranslationSlots", () => {
  test("heals legacy rows that predate a language addition", async () => {
    const { db } = await setup();
    createProject(db, {
      name: "alpha",
      languages: ["en", "nl"],
      defaultLanguage: "en",
      createdBy: "alice",
    });
    const def = createDefinition(db, {
      project: "alpha",
      term: "Widget",
      createdBy: "alice",
    });

    // Simulate a legacy DB: the project gained `fr`+`de` in the languages
    // column without triggering updateProject's backfill path.
    db.run(`UPDATE projects SET languages = ? WHERE name = ?`, [
      JSON.stringify(["en", "nl", "fr", "de"]),
      "alpha",
    ]);

    backfillAllTranslationSlots(db);

    const rows = db
      .prepare(
        `SELECT lang FROM kb_definition_translations WHERE definition_id = ? ORDER BY lang`,
      )
      .all(def.id) as { lang: string }[];
    expect(rows.map((r) => r.lang)).toEqual(["de", "fr", "nl"]);
    db.close();
  });

  test("per-project helper is idempotent", async () => {
    const { db } = await setup();
    createProject(db, {
      name: "alpha",
      languages: ["en", "nl", "fr"],
      defaultLanguage: "en",
      createdBy: "alice",
    });
    const def = createDefinition(db, {
      project: "alpha",
      term: "Widget",
      createdBy: "alice",
    });
    backfillTranslationSlotsForProject(db, "alpha");
    backfillTranslationSlotsForProject(db, "alpha");
    const count = db
      .prepare(
        `SELECT COUNT(*) AS n FROM kb_definition_translations WHERE definition_id = ?`,
      )
      .get(def.id) as { n: number };
    expect(count.n).toBe(2); // nl + fr, not duplicated
    db.close();
  });
});
