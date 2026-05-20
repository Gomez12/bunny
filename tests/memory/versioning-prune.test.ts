/**
 * Tests for `pruneEntityVersions`. The keep rules (see ADR 0046):
 *
 *   1. `version = 1` is always kept.
 *   2. Every lifecycle marker stays (pre_delete / pre_restore / restore /
 *      manual / backfill).
 *   3. The most recent `maxSavePerEntity` `save` rows are kept; older saves
 *      get pruned.
 *
 * The fixture reuses the throw-away `__test__` kind so prune behaviour can be
 * verified end-to-end through the public `recordVersion` writer.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/memory/db.ts";
import {
  configureVersioning,
  listVersions,
  pruneEntityVersions,
  recordVersion,
  registerVersionable,
  unregisterVersionable,
} from "../../src/memory/versioning.ts";

let tmp: string;
let db: Database;

async function newDb(): Promise<Database> {
  tmp = mkdtempSync(join(tmpdir(), "bunny-versioning-prune-"));
  const opened = await openDb(join(tmp, "test.sqlite"));
  opened.run(`
    CREATE TABLE IF NOT EXISTS test_widgets (
      id    INTEGER PRIMARY KEY AUTOINCREMENT,
      name  TEXT NOT NULL,
      value INTEGER NOT NULL
    )
  `);
  return opened;
}

function registerTestKind(): void {
  registerVersionable({
    kind: "__test__",
    table: "test_widgets",
    primaryKey: "id",
    snapshot(database, id) {
      const row = database
        .prepare(`SELECT id, name, value FROM test_widgets WHERE id = ?`)
        .get(Number(id)) as
        | { id: number; name: string; value: number }
        | undefined;
      return row ? { ...row } : null;
    },
    restore(database, id, snapshot) {
      database
        .prepare(`UPDATE test_widgets SET name = ?, value = ? WHERE id = ?`)
        .run(
          String(snapshot["name"] ?? ""),
          Number(snapshot["value"] ?? 0),
          Number(id),
        );
    },
  });
}

function insertWidget(database: Database): number {
  const info = database
    .prepare(`INSERT INTO test_widgets(name, value) VALUES (?, ?)`)
    .run("a", 1);
  return Number(info.lastInsertRowid);
}

/**
 * Record N distinct save versions. Uses a monotonically increasing value so
 * each save has a unique content hash — the dedup short-circuit in
 * `recordVersion` would otherwise collapse identical content into one row.
 */
let saveCounter = 1000;
function recordSaves(database: Database, id: number, n: number): void {
  for (let i = 0; i < n; i++) {
    saveCounter++;
    database
      .prepare(`UPDATE test_widgets SET value = ? WHERE id = ?`)
      .run(saveCounter, id);
    recordVersion(database, "__test__", id, "save", "u-a");
  }
}

beforeEach(async () => {
  db = await newDb();
  registerTestKind();
  // Each test sets its own cap explicitly to make the policy obvious.
  configureVersioning({
    debounceMinutes: 0,
    maxSnapshotBytes: 1_048_576,
    maxVersionsPerEntity: 200,
  });
});

afterEach(() => {
  unregisterVersionable("__test__");
  db.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  configureVersioning({
    debounceMinutes: 5,
    maxSnapshotBytes: 1_048_576,
    maxVersionsPerEntity: 200,
  });
});

describe("pruneEntityVersions", () => {
  test("keeps version 1 + the N newest save rows", () => {
    const id = insertWidget(db);
    recordVersion(db, "__test__", id, "save", "u-a"); // v1
    recordSaves(db, id, 5); // v2..v6, all source='save'

    expect(listVersions(db, "__test__", id)).toHaveLength(6);

    const result = pruneEntityVersions(db, { maxSavePerEntity: 2 });
    // Saves above v1: v2, v3, v4, v5, v6. Keep newest 2 → v6, v5. Prune v2..v4.
    expect(result.deleted).toBe(3);
    expect(result.entities).toBe(1);

    const remaining = listVersions(db, "__test__", id).map((r) => r.version);
    expect(remaining).toEqual([6, 5, 1]);
  });

  test("never drops lifecycle markers regardless of cap", () => {
    const id = insertWidget(db);
    recordVersion(db, "__test__", id, "save", "u-a"); // v1 save

    // Manual is dedup-eligible — bump value so it doesn't collapse into v1.
    saveCounter++;
    db.prepare(`UPDATE test_widgets SET value = ? WHERE id = ?`).run(
      saveCounter,
      id,
    );
    recordVersion(db, "__test__", id, "manual", "u-a"); // v2 manual
    recordSaves(db, id, 1); // v3 save
    recordVersion(db, "__test__", id, "pre_delete", "u-a"); // v4 pre_delete (always inserts)
    recordSaves(db, id, 1); // v5 save
    recordVersion(db, "__test__", id, "pre_restore", "u-a"); // v6 pre_restore
    recordSaves(db, id, 3); // v7..v9 save

    pruneEntityVersions(db, { maxSavePerEntity: 1 });

    const labels = listVersions(db, "__test__", id)
      .map((r) => `${r.version}:${r.source}`)
      .sort();
    // v1 (always kept), every lifecycle row (v2/v4/v6), newest 1 save (v9).
    expect(labels).toEqual([
      "1:save",
      "2:manual",
      "4:pre_delete",
      "6:pre_restore",
      "9:save",
    ]);
  });

  test("zero or negative cap disables pruning", () => {
    const id = insertWidget(db);
    recordVersion(db, "__test__", id, "save", "u-a");
    recordSaves(db, id, 10);
    const before = listVersions(db, "__test__", id).length;

    expect(pruneEntityVersions(db, { maxSavePerEntity: 0 }).deleted).toBe(0);
    expect(pruneEntityVersions(db, { maxSavePerEntity: -1 }).deleted).toBe(0);
    expect(listVersions(db, "__test__", id)).toHaveLength(before);
  });

  test("kind filter scopes the prune to one kind", () => {
    const id = insertWidget(db);
    recordVersion(db, "__test__", id, "save", "u-a");
    recordSaves(db, id, 5);

    // Asking to prune a different kind must not touch our rows.
    const noop = pruneEntityVersions(db, {
      maxSavePerEntity: 1,
      kind: "document",
    });
    expect(noop.deleted).toBe(0);
    expect(listVersions(db, "__test__", id)).toHaveLength(6);

    // Prune for the actual kind reduces to v1 + newest save (v6).
    pruneEntityVersions(db, { maxSavePerEntity: 1, kind: "__test__" });
    const remaining = listVersions(db, "__test__", id).map((r) => r.version);
    expect(remaining).toEqual([6, 1]);
  });

  test("prunes per-entity, not globally", () => {
    // Two entities with the same cap should each get their own newest-N
    // window — pruning one shouldn't affect the other.
    const idA = insertWidget(db);
    const idB = insertWidget(db);
    recordVersion(db, "__test__", idA, "save", "u-a");
    recordSaves(db, idA, 3);
    recordVersion(db, "__test__", idB, "save", "u-a");
    recordSaves(db, idB, 3);

    pruneEntityVersions(db, { maxSavePerEntity: 1 });

    expect(listVersions(db, "__test__", idA).map((r) => r.version)).toEqual([
      4, 1,
    ]);
    expect(listVersions(db, "__test__", idB).map((r) => r.version)).toEqual([
      4, 1,
    ]);
  });

  test("uses config default when no override is passed", () => {
    configureVersioning({ maxVersionsPerEntity: 2 });
    const id = insertWidget(db);
    recordVersion(db, "__test__", id, "save", "u-a");
    recordSaves(db, id, 5);

    pruneEntityVersions(db);

    const versions = listVersions(db, "__test__", id).map((r) => r.version);
    expect(versions).toEqual([6, 5, 1]);
  });
});
