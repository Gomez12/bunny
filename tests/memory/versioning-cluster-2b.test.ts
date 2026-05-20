/**
 * Round-trip smoke tests for the remaining Phase 2b kinds — whiteboards,
 * diary_entry, kb_definition. Asserts `recordVersion` → `restoreVersion`
 * actually reapplies the snapshot through the per-kind restore function.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/memory/db.ts";
import { createProject } from "../../src/memory/projects.ts";
import {
  createWhiteboard,
  getWhiteboard,
  updateWhiteboard,
} from "../../src/memory/whiteboards.ts";
import {
  createDiaryEntry,
  getDiaryEntry,
  updateDiaryEntry,
} from "../../src/memory/diary.ts";
import {
  createDefinition,
  getDefinition,
  updateDefinition,
} from "../../src/memory/kb_definitions.ts";
import {
  configureVersioning,
  recordVersion,
  restoreVersion,
} from "../../src/memory/versioning.ts";

let tmp: string;

async function setup() {
  tmp = mkdtempSync(join(tmpdir(), "bunny-versioning-2b-"));
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

beforeEach(() => {
  // Two saves in quick succession would otherwise debounce into one row and
  // hide the regression each test checks. The default (5 min) is the prod
  // behaviour; this suite explicitly wants each save to land as its own row.
  configureVersioning({ debounceMinutes: 0, maxSnapshotBytes: 1_048_576 });
});

afterEach(() => {
  configureVersioning({ debounceMinutes: 5, maxSnapshotBytes: 1_048_576 });
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("whiteboards versioning", () => {
  test("restoreVersion reverts elements_json + name", async () => {
    const db = await setup();
    const wb = createWhiteboard(db, {
      project: "alpha",
      name: "Board",
      createdBy: "alice",
    });
    updateWhiteboard(db, wb.id, { elementsJson: '{"v":1}' });
    recordVersion(db, "whiteboard", wb.id, "save", "alice");

    updateWhiteboard(db, wb.id, {
      name: "Board v2",
      elementsJson: '{"v":2}',
    });
    recordVersion(db, "whiteboard", wb.id, "save", "alice");

    restoreVersion(db, "whiteboard", wb.id, 1, "alice");

    const restored = getWhiteboard(db, wb.id)!;
    expect(restored.name).toBe("Board");
    expect(restored.elementsJson).toBe('{"v":1}');
    db.close();
  });
});

describe("diary_entry versioning", () => {
  test("restoreVersion reverts title + transcription", async () => {
    const db = await setup();
    const entry = createDiaryEntry(db, {
      project: "alpha",
      userId: "alice",
      title: "Day 1",
      language: "nl",
    });
    // Transcription is worker-written (no public setter on updateDiaryEntry),
    // so seed it directly. The version restorer still has to round-trip it.
    db.prepare(
      `UPDATE diary_entries SET transcription = ? WHERE id = ?`,
    ).run("first draft", entry.id);
    recordVersion(db, "diary_entry", entry.id, "save", "alice");

    updateDiaryEntry(db, entry.id, { title: "Day 1 - retitled" });
    db.prepare(
      `UPDATE diary_entries SET transcription = ? WHERE id = ?`,
    ).run("second draft", entry.id);
    recordVersion(db, "diary_entry", entry.id, "save", "alice");

    restoreVersion(db, "diary_entry", entry.id, 1, "alice");

    const restored = getDiaryEntry(db, entry.id)!;
    expect(restored.title).toBe("Day 1");
    expect(restored.transcription).toBe("first draft");
    db.close();
  });
});

describe("kb_definition versioning", () => {
  test("restoreVersion reverts manual_description + active_description", async () => {
    const db = await setup();
    const def = createDefinition(db, {
      project: "alpha",
      term: "Bunny",
      manualDescription: "first definition",
      createdBy: "alice",
    });
    recordVersion(db, "kb_definition", def.id, "save", "alice");

    updateDefinition(db, def.id, {
      manualDescription: "rewritten definition",
      activeDescription: "short",
    });
    recordVersion(db, "kb_definition", def.id, "save", "alice");

    restoreVersion(db, "kb_definition", def.id, 1, "alice");

    const restored = getDefinition(db, def.id)!;
    expect(restored.manualDescription).toBe("first definition");
    expect(restored.activeDescription).toBe("manual");
    db.close();
  });
});
