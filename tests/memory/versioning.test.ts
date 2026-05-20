/**
 * Foundation tests for the universal entity-versioning system. Uses a
 * throw-away `__test__` kind backed by an in-test table so the assertions
 * exercise the public API (`recordVersion` / `listVersions` / `getVersion` /
 * `restoreVersion`) without depending on any production registration.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/memory/db.ts";
import {
  canonicalStringify,
  configureVersioning,
  countVersions,
  getVersion,
  listVersions,
  recordVersion,
  recordVersionInTx,
  redactKeys,
  registerVersionable,
  restoreVersion,
  unregisterVersionable,
} from "../../src/memory/versioning.ts";

let tmp: string;
let db: Database;

async function newDb(): Promise<Database> {
  tmp = mkdtempSync(join(tmpdir(), "bunny-versioning-"));
  const opened = await openDb(join(tmp, "test.sqlite"));
  // Test fixture table — not part of the production schema.
  opened.run(`
    CREATE TABLE IF NOT EXISTS test_widgets (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      name    TEXT NOT NULL,
      value   INTEGER NOT NULL,
      secret  TEXT
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
        .prepare(
          `SELECT id, name, value, secret FROM test_widgets WHERE id = ?`,
        )
        .get(Number(id)) as
        | { id: number; name: string; value: number; secret: string | null }
        | undefined;
      return row ? { ...row } : null;
    },
    restore(database, id, snapshot) {
      database
        .prepare(
          `UPDATE test_widgets
              SET name = ?, value = ?, secret = ?
            WHERE id = ?`,
        )
        .run(
          String(snapshot["name"] ?? ""),
          Number(snapshot["value"] ?? 0),
          (snapshot["secret"] as string | null) ?? null,
          Number(id),
        );
    },
    redact: (snap) => redactKeys(snap),
  });
}

function insertWidget(
  database: Database,
  name: string,
  value: number,
  secret: string | null = null,
): number {
  const info = database
    .prepare(`INSERT INTO test_widgets(name, value, secret) VALUES (?, ?, ?)`)
    .run(name, value, secret);
  return Number(info.lastInsertRowid);
}

beforeEach(async () => {
  db = await newDb();
  registerTestKind();
  configureVersioning({ debounceMinutes: 5, maxSnapshotBytes: 1_048_576 });
});

afterEach(() => {
  unregisterVersionable("__test__");
  db.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  // Reset back to defaults so other suites are unaffected.
  configureVersioning({ debounceMinutes: 5, maxSnapshotBytes: 1_048_576 });
});

describe("recordVersion", () => {
  test("first call inserts version 1", () => {
    const id = insertWidget(db, "a", 1);
    const r = recordVersion(db, "__test__", id, "save", "user-a");
    expect(r.outcome).toBe("inserted");
    expect(r.version).toBe(1);
    expect(countVersions(db, "__test__", id)).toBe(1);
  });

  test("identical content is skipped, not appended", () => {
    const id = insertWidget(db, "a", 1);
    recordVersion(db, "__test__", id, "save", "user-a");
    const r = recordVersion(db, "__test__", id, "save", "user-a");
    expect(r.outcome).toBe("skipped");
    expect(countVersions(db, "__test__", id)).toBe(1);
  });

  test("changed content within debounce window overwrites previous row", () => {
    const id = insertWidget(db, "a", 1);
    const first = recordVersion(db, "__test__", id, "save", "user-a");

    db.prepare(`UPDATE test_widgets SET value = ? WHERE id = ?`).run(2, id);
    const second = recordVersion(db, "__test__", id, "save", "user-a");

    expect(second.outcome).toBe("debounced");
    expect(second.versionId).toBe(first.versionId);
    expect(second.version).toBe(1);
    expect(countVersions(db, "__test__", id)).toBe(1);

    const detail = getVersion(db, "__test__", id, 1);
    expect(detail?.snapshot?.["value"]).toBe(2);
  });

  test("different user breaks debounce and appends a new version", () => {
    const id = insertWidget(db, "a", 1);
    recordVersion(db, "__test__", id, "save", "user-a");
    db.prepare(`UPDATE test_widgets SET value = ? WHERE id = ?`).run(2, id);
    const r = recordVersion(db, "__test__", id, "save", "user-b");
    expect(r.outcome).toBe("inserted");
    expect(r.version).toBe(2);
    expect(countVersions(db, "__test__", id)).toBe(2);
  });

  test("pre_delete never debounces — always appends", () => {
    const id = insertWidget(db, "a", 1);
    recordVersion(db, "__test__", id, "save", "user-a");
    db.prepare(`UPDATE test_widgets SET value = ? WHERE id = ?`).run(2, id);
    const r = recordVersion(db, "__test__", id, "pre_delete", "user-a");
    expect(r.outcome).toBe("inserted");
    expect(r.version).toBe(2);
  });

  test("manual snapshot with identical content is skipped", () => {
    // Manual snapshots obey content-hash dedup so a user mashing the snapshot
    // button doesn't produce a chain of identical rows. The escape hatch is to
    // change something first.
    const id = insertWidget(db, "a", 1);
    recordVersion(db, "__test__", id, "save", "user-a");
    const r = recordVersion(db, "__test__", id, "manual", "user-a");
    expect(r.outcome).toBe("skipped");
    expect(countVersions(db, "__test__", id)).toBe(1);
  });

  test("pre_restore with identical content still appends (audit trail)", () => {
    // Lifecycle markers must always materialise: a restore happened, even if
    // the entity already looked like the target version. Otherwise you lose
    // the "this was the state right before restore" rollback signal.
    const id = insertWidget(db, "a", 1);
    recordVersion(db, "__test__", id, "save", "user-a");
    const r = recordVersion(db, "__test__", id, "pre_restore", "user-a");
    expect(r.outcome).toBe("inserted");
    expect(countVersions(db, "__test__", id)).toBe(2);
  });

  test("two distinct oversized payloads produce two rows (no hash collision)", () => {
    // Regression: hashing the truncated stub "{}" instead of the full payload
    // would make every oversized save collide on sha256("{}") and the second
    // would return "skipped" — silent data loss.
    configureVersioning({ debounceMinutes: 0, maxSnapshotBytes: 16 });
    const id = insertWidget(db, "first-payload-that-overflows", 1);
    const first = recordVersion(db, "__test__", id, "save", "user-a");
    db.prepare(`UPDATE test_widgets SET name = ? WHERE id = ?`).run(
      "second-payload-that-also-overflows-but-different",
      id,
    );
    const second = recordVersion(db, "__test__", id, "save", "user-a");
    expect(first.outcome).toBe("inserted");
    expect(second.outcome).toBe("inserted");
    expect(second.version).toBe(2);
  });

  test("save outside debounce window appends a new version", () => {
    configureVersioning({ debounceMinutes: 0, maxSnapshotBytes: 1_048_576 });
    const id = insertWidget(db, "a", 1);
    recordVersion(db, "__test__", id, "save", "user-a");
    db.prepare(`UPDATE test_widgets SET value = ? WHERE id = ?`).run(2, id);
    const r = recordVersion(db, "__test__", id, "save", "user-a");
    expect(r.outcome).toBe("inserted");
    expect(r.version).toBe(2);
  });

  test("missing entity returns 'missing' without writing", () => {
    const r = recordVersion(db, "__test__", 99999, "save", "user-a");
    expect(r.outcome).toBe("missing");
    expect(r.versionId).toBeNull();
  });

  test("oversized snapshot is flagged and snapshot_json is dropped", () => {
    configureVersioning({ debounceMinutes: 5, maxSnapshotBytes: 16 });
    const id = insertWidget(db, "wide-name-that-overflows-tiny-cap", 1);
    const r = recordVersion(db, "__test__", id, "save", "user-a");
    expect(r.outcome).toBe("inserted");
    const detail = getVersion(db, "__test__", id, 1);
    expect(detail?.flags).toContain("oversized");
    expect(detail?.snapshot).toBeNull();
  });

  test("redaction sets the 'redacted' flag and masks secret-shaped fields", () => {
    const id = insertWidget(db, "a", 1, "very-real-token");
    recordVersion(db, "__test__", id, "save", "user-a");
    const detail = getVersion(db, "__test__", id, 1);
    expect(detail?.flags).toContain("redacted");
    expect(detail?.snapshot?.["secret"]).toBe("[REDACTED]");
  });
});

describe("listVersions / getVersion", () => {
  test("listVersions returns rows newest first without snapshot_json", () => {
    const id = insertWidget(db, "a", 1);
    configureVersioning({ debounceMinutes: 0, maxSnapshotBytes: 1_048_576 });
    recordVersion(db, "__test__", id, "save", "user-a");
    db.prepare(`UPDATE test_widgets SET value = ? WHERE id = ?`).run(2, id);
    recordVersion(db, "__test__", id, "save", "user-a");
    const rows = listVersions(db, "__test__", id);
    expect(rows.map((r) => r.version)).toEqual([2, 1]);
    expect(rows[0]).not.toHaveProperty("snapshot");
  });

  test("getVersion returns the parsed snapshot", () => {
    const id = insertWidget(db, "hello", 42);
    recordVersion(db, "__test__", id, "save", "user-a");
    const detail = getVersion(db, "__test__", id, 1);
    expect(detail?.snapshot?.["name"]).toBe("hello");
    expect(detail?.snapshot?.["value"]).toBe(42);
  });
});

describe("restoreVersion", () => {
  test("restores entity state and records a pre_restore snapshot", () => {
    configureVersioning({ debounceMinutes: 0, maxSnapshotBytes: 1_048_576 });
    const id = insertWidget(db, "a", 1);
    recordVersion(db, "__test__", id, "save", "user-a");
    db.prepare(`UPDATE test_widgets SET value = ? WHERE id = ?`).run(99, id);
    recordVersion(db, "__test__", id, "save", "user-a");

    restoreVersion(db, "__test__", id, 1, "user-a");

    const widget = db
      .prepare(`SELECT value FROM test_widgets WHERE id = ?`)
      .get(id) as { value: number };
    expect(widget.value).toBe(1);

    const rows = listVersions(db, "__test__", id);
    expect(rows.map((r) => r.source)).toEqual(["pre_restore", "save", "save"]);
  });

  test("refuses to restore an oversized snapshot", () => {
    configureVersioning({ debounceMinutes: 5, maxSnapshotBytes: 16 });
    const id = insertWidget(db, "wide-name-that-overflows-tiny-cap", 1);
    recordVersion(db, "__test__", id, "save", "user-a");
    expect(() => restoreVersion(db, "__test__", id, 1, "user-a")).toThrow(
      /oversized/,
    );
  });

  test("throws on unknown version", () => {
    const id = insertWidget(db, "a", 1);
    expect(() => restoreVersion(db, "__test__", id, 7, "user-a")).toThrow(
      /version not found/,
    );
  });
});

describe("recordVersionInTx", () => {
  test("works inside an existing db.transaction without nested BEGIN error", () => {
    // Routes that update sidecars alongside the main entity wrap their writes
    // in db.transaction(...). The hook must call recordVersionInTx here —
    // recordVersion would try to BEGIN inside an open BEGIN and throw.
    const id = insertWidget(db, "a", 1);
    const tx = db.transaction(() => {
      db.prepare(`UPDATE test_widgets SET value = ? WHERE id = ?`).run(2, id);
      return recordVersionInTx(db, "__test__", id, "save", "user-a");
    });
    const r = tx();
    expect(r.outcome).toBe("inserted");
    expect(countVersions(db, "__test__", id)).toBe(1);
    expect(getVersion(db, "__test__", id, 1)?.snapshot?.["value"]).toBe(2);
  });
});

describe("canonicalStringify", () => {
  test("key order does not affect hash", () => {
    const a = canonicalStringify({ b: 2, a: 1 });
    const b = canonicalStringify({ a: 1, b: 2 });
    expect(a).toBe(b);
  });

  test("array order is preserved", () => {
    expect(canonicalStringify([1, 2])).not.toBe(canonicalStringify([2, 1]));
  });
});
