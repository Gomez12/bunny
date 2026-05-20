/**
 * Phase 2c round-trip smoke tests — contacts, businesses, board_cards. Each
 * test seeds an entity, mutates it, then restores version 1 to confirm the
 * registered `snapshot` + `restore` cover the source-of-truth fields without
 * dragging worker-state into the version chain.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/memory/db.ts";
import { createProject } from "../../src/memory/projects.ts";
import {
  createContact,
  getContact,
  updateContact,
} from "../../src/memory/contacts.ts";
import {
  createBusiness,
  getBusiness,
  updateBusiness,
} from "../../src/memory/businesses.ts";
import {
  createCard,
  getCard,
  updateCard,
} from "../../src/memory/board_cards.ts";
import { createSwimlane } from "../../src/memory/board_swimlanes.ts";
import {
  configureVersioning,
  recordVersion,
  restoreVersion,
} from "../../src/memory/versioning.ts";

let tmp: string;

async function setup() {
  tmp = mkdtempSync(join(tmpdir(), "bunny-versioning-2c-"));
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
  configureVersioning({ debounceMinutes: 0, maxSnapshotBytes: 1_048_576 });
});

afterEach(() => {
  configureVersioning({ debounceMinutes: 5, maxSnapshotBytes: 1_048_576 });
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("contact versioning", () => {
  test("restoreVersion reverts notes + tags", async () => {
    const db = await setup();
    const c = createContact(db, {
      project: "alpha",
      name: "Bob",
      notes: "first",
      tags: ["friend"],
      createdBy: "alice",
    });
    recordVersion(db, "contact", c.id, "save", "alice");

    updateContact(db, c.id, { notes: "second", tags: ["coworker"] });
    recordVersion(db, "contact", c.id, "save", "alice");

    restoreVersion(db, "contact", c.id, 1, "alice");
    const restored = getContact(db, c.id)!;
    expect(restored.notes).toBe("first");
    expect(restored.tags).toEqual(["friend"]);
    db.close();
  });
});

describe("business versioning", () => {
  test("restoreVersion reverts description + website", async () => {
    const db = await setup();
    const b = createBusiness(db, {
      project: "alpha",
      name: "Acme",
      description: "first",
      website: "https://a.example",
      source: "manual",
      createdBy: "alice",
    });
    recordVersion(db, "business", b.id, "save", "alice");

    updateBusiness(db, b.id, {
      description: "second",
      website: "https://b.example",
    });
    recordVersion(db, "business", b.id, "save", "alice");

    restoreVersion(db, "business", b.id, 1, "alice");
    const restored = getBusiness(db, b.id)!;
    expect(restored.description).toBe("first");
    expect(restored.website).toBe("https://a.example");
    db.close();
  });
});

describe("board_card versioning", () => {
  test("restoreVersion reverts title + description, leaves position alone", async () => {
    const db = await setup();
    const lane = createSwimlane(db, {
      project: "alpha",
      name: "Lane-X",
      position: 100,
    });
    const card = createCard(db, {
      project: "alpha",
      swimlaneId: lane.id,
      title: "first",
      description: "desc-1",
      createdBy: "alice",
    });
    recordVersion(db, "board_card", card.id, "save", "alice");

    updateCard(db, card.id, { title: "second", description: "desc-2" });
    recordVersion(db, "board_card", card.id, "save", "alice");

    restoreVersion(db, "board_card", card.id, 1, "alice");
    const restored = getCard(db, card.id)!;
    expect(restored.title).toBe("first");
    expect(restored.description).toBe("desc-1");
    // Position is intentionally not snapshotted — restore must leave it alone.
    expect(restored.position).toBe(card.position);
    db.close();
  });
});
