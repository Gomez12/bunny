/**
 * Lint test: every registered VersionableEntityDef whose underlying table has
 * a column matching the shared secret pattern must declare a `redact`
 * function. Without it, secrets like API keys and bot tokens would be frozen
 * into version snapshots and survive even after rotation — violating the
 * "Avoid logging secrets / Exposing tokens" rule in AGENTS.md.
 *
 * The check runs against the live registry: any kind added during boot is
 * audited the next time CI runs this test. Tests that need to register a
 * temporary `__test__` kind clean up after themselves.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/memory/db.ts";
import {
  SECRET_COLUMN_PATTERN,
  listVersionableKinds,
} from "../../src/memory/versioning.ts";

let tmp: string;
let db: Database;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "bunny-versioning-redaction-"));
  db = await openDb(join(tmp, "test.sqlite"));
});

afterAll(() => {
  db.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function getColumnNames(database: Database, table: string): string[] {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  return rows.map((r) => r.name);
}

describe("VersionableEntityDef redaction policy", () => {
  test("every kind with secret-shaped columns declares redact", () => {
    const offenders: string[] = [];
    for (const def of listVersionableKinds()) {
      const cols = getColumnNames(db, def.table);
      if (cols.length === 0) continue; // table not present in this DB build
      const secretCols = cols.filter((c) => SECRET_COLUMN_PATTERN.test(c));
      if (secretCols.length > 0 && !def.redact) {
        offenders.push(
          `${def.kind} (${def.table}: ${secretCols.join(", ")}) missing redact`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });
});
