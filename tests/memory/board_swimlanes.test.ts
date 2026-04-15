import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/memory/db.ts";
import { createProject } from "../../src/memory/projects.ts";
import {
  DEFAULT_SWIMLANES,
  POSITION_STEP,
  createSwimlane,
  deleteSwimlane,
  listSwimlanes,
  seedDefaultSwimlanes,
  updateSwimlane,
} from "../../src/memory/board_swimlanes.ts";
import { createCard } from "../../src/memory/board_cards.ts";

let tmp: string;

async function newDb() {
  tmp = mkdtempSync(join(tmpdir(), "bunny-board-lanes-"));
  return openDb(join(tmp, "test.sqlite"));
}

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("seedDefaultSwimlanes", () => {
  test("createProject auto-seeds Todo/Doing/Done", async () => {
    const db = await newDb();
    createProject(db, { name: "alpha" });
    const lanes = listSwimlanes(db, "alpha");
    expect(lanes.map((l) => l.name)).toEqual([...DEFAULT_SWIMLANES]);
    expect(lanes.map((l) => l.position)).toEqual([POSITION_STEP, POSITION_STEP * 2, POSITION_STEP * 3]);
    db.close();
  });

  test("is idempotent — second call adds nothing", async () => {
    const db = await newDb();
    createProject(db, { name: "alpha" });
    seedDefaultSwimlanes(db, "alpha");
    expect(listSwimlanes(db, "alpha")).toHaveLength(DEFAULT_SWIMLANES.length);
    db.close();
  });
});

describe("swimlane CRUD", () => {
  test("createSwimlane defaults position to next step", async () => {
    const db = await newDb();
    createProject(db, { name: "alpha" });
    const lane = createSwimlane(db, { project: "alpha", name: "Review" });
    expect(lane.position).toBe(POSITION_STEP * 4);
    db.close();
  });

  test("UNIQUE(project, name) enforced", async () => {
    const db = await newDb();
    createProject(db, { name: "alpha" });
    expect(() => createSwimlane(db, { project: "alpha", name: "Todo" })).toThrow();
    db.close();
  });

  test("updateSwimlane patches name + wip_limit", async () => {
    const db = await newDb();
    createProject(db, { name: "alpha" });
    const lane = listSwimlanes(db, "alpha")[0]!;
    const updated = updateSwimlane(db, lane.id, { name: "Backlog", wipLimit: 5 });
    expect(updated.name).toBe("Backlog");
    expect(updated.wipLimit).toBe(5);
    db.close();
  });

  test("deleteSwimlane refuses when active cards remain", async () => {
    const db = await newDb();
    createProject(db, { name: "alpha" });
    const lane = listSwimlanes(db, "alpha")[0]!;
    createCard(db, {
      project: "alpha",
      swimlaneId: lane.id,
      title: "task",
      createdBy: "u1",
    });
    expect(() => deleteSwimlane(db, lane.id)).toThrow(/active cards/);
    db.close();
  });

  test("deleteSwimlane succeeds on empty lane", async () => {
    const db = await newDb();
    createProject(db, { name: "alpha" });
    const lane = createSwimlane(db, { project: "alpha", name: "Empty" });
    deleteSwimlane(db, lane.id);
    expect(listSwimlanes(db, "alpha").map((l) => l.name)).not.toContain("Empty");
    db.close();
  });
});
