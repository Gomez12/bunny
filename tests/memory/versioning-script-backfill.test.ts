/**
 * Verifies the one-time `script_versions` → `entity_versions` backfill that
 * runs inside `openDb()`'s migration path. The legacy chain stays untouched
 * (existing `ScriptVersionsView` continues to work); the new chain lets the
 * universal History UI browse the same history.
 *
 * Strategy: open the DB, seed legacy rows, close, re-open. The second open
 * runs the migration over the now-populated `script_versions` table and
 * inserts mirror rows into `entity_versions` with `source='backfill'`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/memory/db.ts";
import { createProject } from "../../src/memory/projects.ts";
import {
  createCodeProject,
} from "../../src/memory/code_projects.ts";
import { createScript } from "../../src/memory/scripts.ts";

let tmp: string;

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("script_versions → entity_versions backfill", () => {
  test("legacy rows materialise as backfilled entity_versions on next open", async () => {
    tmp = mkdtempSync(join(tmpdir(), "bunny-script-backfill-"));
    const path = join(tmp, "test.sqlite");

    // 1. Seed schema + a script with two legacy script_versions rows.
    {
      const db = await openDb(path);
      const now = Date.now();
      db.run(
        `INSERT INTO users(id, username, password_hash, role, created_at, updated_at)
         VALUES ('alice', 'alice', 'x', 'admin', ?, ?)`,
        [now, now],
      );
      createProject(db, { name: "alpha", createdBy: "alice" });
      const cp = createCodeProject(db, {
        project: "alpha",
        name: "core",
        createdBy: "alice",
      });
      const script = createScript(db, {
        codeProjectId: cp.id,
        project: "alpha",
        name: "hello",
        content: "console.log(0)",
        createdBy: "alice",
      });
      // Two legacy rows. The backfill must assign them version 1 and 2 in
      // created_at order.
      db.prepare(
        `INSERT INTO script_versions(script_id, content, created_by, created_at)
         VALUES (?, ?, ?, ?)`,
      ).run(script.id, "console.log(1)", "alice", now - 2_000);
      db.prepare(
        `INSERT INTO script_versions(script_id, content, created_by, created_at)
         VALUES (?, ?, ?, ?)`,
      ).run(script.id, "console.log(2)", "alice", now - 1_000);

      // Sanity — the new chain is empty before we re-open.
      const before = db
        .prepare(
          `SELECT COUNT(*) AS n FROM entity_versions WHERE kind = 'script'`,
        )
        .get() as { n: number };
      expect(before.n).toBe(0);
      db.close();
    }

    // 2. Re-open triggers migration → backfill should land.
    {
      const db = await openDb(path);
      const rows = db
        .prepare(
          `SELECT entity_id, version, source, snapshot_json, created_at
             FROM entity_versions
            WHERE kind = 'script'
            ORDER BY version ASC`,
        )
        .all() as {
        entity_id: string;
        version: number;
        source: string;
        snapshot_json: string;
        created_at: number;
      }[];
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.source === "backfill")).toBe(true);
      expect(rows.map((r) => r.version)).toEqual([1, 2]);
      // Created-at is preserved from the legacy row so the timeline stays
      // chronological; the JSON carries `content` + the legacy id.
      expect(rows[0]!.created_at).toBeLessThan(rows[1]!.created_at);
      const snap0 = JSON.parse(rows[0]!.snapshot_json) as Record<string, unknown>;
      expect(snap0["content"]).toBe("console.log(1)");
      expect(typeof snap0["legacy_script_version_id"]).toBe("number");
      db.close();
    }

    // 3. Idempotent: a third open should not duplicate rows. The UNIQUE
    // constraint + INSERT OR IGNORE absorbs the re-run silently.
    {
      const db = await openDb(path);
      const count = db
        .prepare(
          `SELECT COUNT(*) AS n FROM entity_versions WHERE kind = 'script'`,
        )
        .get() as { n: number };
      expect(count.n).toBe(2);
      db.close();
    }
  });

  test("no-op when script_versions is empty", async () => {
    tmp = mkdtempSync(join(tmpdir(), "bunny-script-backfill-empty-"));
    const db = await openDb(join(tmp, "test.sqlite"));
    const count = db
      .prepare(
        `SELECT COUNT(*) AS n FROM entity_versions WHERE kind = 'script'`,
      )
      .get() as { n: number };
    expect(count.n).toBe(0);
    db.close();
  });
});
