/**
 * Integration tests for the trash → versioning hooks. `softDelete` must
 * capture a `pre_delete` snapshot of the *live* row (un-mangled name, sidecars
 * intact) before the rename/sidecar drop runs; `restore` must add a
 * `pre_restore` marker once existence + name-conflict checks pass. Both calls
 * are no-ops when the kind has not been registered as versionable.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/memory/db.ts";
import {
  registerTrashable,
  restore,
  softDelete,
} from "../../src/memory/trash.ts";
import {
  countVersions,
  listVersions,
  registerVersionable,
  unregisterVersionable,
} from "../../src/memory/versioning.ts";

let tmp: string;
let db: Database;

async function newDb(): Promise<Database> {
  tmp = mkdtempSync(join(tmpdir(), "bunny-versioning-trash-"));
  const opened = await openDb(join(tmp, "test.sqlite"));
  // Minimal trashable+versionable fixture: a row with a `name` column under a
  // UNIQUE(project, name) constraint so soft-delete exercises the rename path.
  opened.run(`
    CREATE TABLE IF NOT EXISTS fixture_documents (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      project    TEXT    NOT NULL,
      name       TEXT    NOT NULL,
      body       TEXT    NOT NULL DEFAULT '',
      created_by TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER,
      deleted_by TEXT,
      UNIQUE(project, name)
    )
  `);
  return opened;
}

function insertFixture(database: Database, name: string, body = ""): number {
  const now = Date.now();
  const info = database
    .prepare(
      `INSERT INTO fixture_documents(project, name, body, created_at, updated_at)
       VALUES ('alpha', ?, ?, ?, ?)`,
    )
    .run(name, body, now, now);
  return Number(info.lastInsertRowid);
}

beforeEach(async () => {
  db = await newDb();
  // Register the fixture as both trashable and versionable. The trash registry
  // accepts the string "document" — that's the production TrashKind, fine to
  // reuse here because the registry is in-memory per test process.
  registerTrashable({
    kind: "document",
    table: "fixture_documents",
    nameColumn: "name",
    hasUniqueName: true,
    translationSidecarTable: null,
    translationSidecarFk: null,
  });
  registerVersionable({
    kind: "document",
    table: "fixture_documents",
    primaryKey: "id",
    snapshot(database, id) {
      const row = database
        .prepare(
          `SELECT id, project, name, body FROM fixture_documents WHERE id = ?`,
        )
        .get(Number(id)) as
        | { id: number; project: string; name: string; body: string }
        | undefined;
      return row ? { ...row } : null;
    },
    restore(database, id, snapshot) {
      database
        .prepare(
          `UPDATE fixture_documents
              SET name = ?, body = ?
            WHERE id = ?`,
        )
        .run(
          String(snapshot["name"] ?? ""),
          String(snapshot["body"] ?? ""),
          Number(id),
        );
    },
  });
});

afterEach(() => {
  unregisterVersionable("document");
  db.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("trash → versioning hooks", () => {
  test("softDelete captures pre_delete with the un-mangled name", () => {
    const id = insertFixture(db, "Plan", "draft body");
    softDelete(db, "document", id, "alice");

    const versions = listVersions(db, "document", id);
    expect(versions).toHaveLength(1);
    const first = versions[0]!;
    expect(first.source).toBe("pre_delete");
    expect(first.createdBy).toBe("alice");

    // The mangled name in the DB must NOT bleed into the snapshot — otherwise
    // a future restore from this version would write "__trash:N:Plan" back.
    const detail = db
      .prepare(
        `SELECT snapshot_json FROM entity_versions WHERE id = ?`,
      )
      .get(first.id) as { snapshot_json: string };
    const snap = JSON.parse(detail.snapshot_json) as Record<string, unknown>;
    expect(snap["name"]).toBe("Plan");
    expect(snap["body"]).toBe("draft body");
  });

  test("restore appends a pre_restore marker", () => {
    const id = insertFixture(db, "Plan");
    softDelete(db, "document", id, "alice");
    expect(restore(db, "document", id)).toBe("ok");

    const versions = listVersions(db, "document", id);
    expect(versions.map((v) => v.source)).toEqual([
      "pre_restore",
      "pre_delete",
    ]);
  });

  test("name_conflict skips the pre_restore marker", () => {
    const id = insertFixture(db, "Plan");
    softDelete(db, "document", id, "alice");
    // Recreate a live row with the same name — restore must now fail.
    insertFixture(db, "Plan");

    expect(restore(db, "document", id)).toBe("name_conflict");

    const versions = listVersions(db, "document", id);
    expect(versions.map((v) => v.source)).toEqual(["pre_delete"]);
  });

  test("softDelete on a non-versionable kind is a silent no-op", () => {
    // Drop the versioning registration only; trash stays registered.
    unregisterVersionable("document");
    const id = insertFixture(db, "OnlyTrash");
    expect(softDelete(db, "document", id, "alice")).toBe(true);
    expect(countVersions(db, "document", id)).toBe(0);
  });
});
