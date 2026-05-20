/**
 * Round-trip integration test: documents.ts registers as versionable and the
 * trash hook now records `pre_delete` snapshots automatically. This test
 * exercises the registered `snapshot` / `restore` pair through the public
 * `recordVersion` + `restoreVersion` API to guarantee the document is the
 * first kind to ship Phase 2b of the entity-versioning plan.
 */

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
  updateDocument,
} from "../../src/memory/documents.ts";
import {
  countVersions,
  listVersions,
  recordVersion,
  restoreVersion,
} from "../../src/memory/versioning.ts";

let tmp: string;

async function setup() {
  tmp = mkdtempSync(join(tmpdir(), "bunny-versioning-documents-"));
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

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("documents versioning", () => {
  test("recordVersion + restoreVersion round-trip the source fields", async () => {
    const db = await setup();
    const doc = createDocument(db, {
      project: "alpha",
      name: "Plan",
      contentMd: "# v1",
      createdBy: "alice",
    });
    recordVersion(db, "document", doc.id, "save", "alice");

    updateDocument(db, doc.id, { name: "Plan v2", contentMd: "# v2" });
    expect(getDocument(db, doc.id)?.contentMd).toBe("# v2");

    // Restoring jumps back to version 1's content. The pre_restore marker the
    // API takes before applying the snapshot keeps the rollback reversible.
    restoreVersion(db, "document", doc.id, 1, "alice");

    const restored = getDocument(db, doc.id)!;
    expect(restored.name).toBe("Plan");
    expect(restored.contentMd).toBe("# v1");
    db.close();
  });

  test("deleteDocument creates a pre_delete snapshot with the un-mangled name", async () => {
    const db = await setup();
    const doc = createDocument(db, {
      project: "alpha",
      name: "Plan",
      contentMd: "body",
      createdBy: "alice",
    });
    deleteDocument(db, doc.id, "alice");

    expect(countVersions(db, "document", doc.id)).toBe(1);
    const [version] = listVersions(db, "document", doc.id);
    expect(version?.source).toBe("pre_delete");

    // Raw row check: the snapshot must carry the original name, not the
    // `__trash:<id>:Plan` mangled form the soft-delete path writes back to
    // the documents row.
    const raw = db
      .prepare(`SELECT snapshot_json FROM entity_versions WHERE id = ?`)
      .get(version!.id) as { snapshot_json: string };
    const snap = JSON.parse(raw.snapshot_json) as Record<string, unknown>;
    expect(snap["name"]).toBe("Plan");
    expect(snap["content_md"]).toBe("body");
    db.close();
  });
});
