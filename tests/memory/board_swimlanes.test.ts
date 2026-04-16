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

  test("create with default assignee and next swimlane", async () => {
    const db = await newDb();
    createProject(db, { name: "alpha" });
    const lanes = listSwimlanes(db, "alpha");
    const lane = createSwimlane(db, {
      project: "alpha",
      name: "Review",
      defaultAssigneeAgent: "bot",
      nextSwimlaneId: lanes[2]!.id,
    });
    expect(lane.defaultAssigneeAgent).toBe("bot");
    expect(lane.defaultAssigneeUserId).toBeNull();
    expect(lane.nextSwimlaneId).toBe(lanes[2]!.id);
    db.close();
  });

  test("update default assignee and next swimlane", async () => {
    const db = await newDb();
    createProject(db, { name: "alpha" });
    const lanes = listSwimlanes(db, "alpha");
    const lane = lanes[0]!;
    expect(lane.defaultAssigneeAgent).toBeNull();
    expect(lane.nextSwimlaneId).toBeNull();
    const updated = updateSwimlane(db, lane.id, {
      defaultAssigneeUserId: "user1",
      nextSwimlaneId: lanes[1]!.id,
    });
    expect(updated.defaultAssigneeUserId).toBe("user1");
    expect(updated.defaultAssigneeAgent).toBeNull();
    expect(updated.nextSwimlaneId).toBe(lanes[1]!.id);
    db.close();
  });

  test("clear default assignee by setting to null", async () => {
    const db = await newDb();
    createProject(db, { name: "alpha" });
    const lanes = listSwimlanes(db, "alpha");
    updateSwimlane(db, lanes[0]!.id, { defaultAssigneeAgent: "bot" });
    const updated = updateSwimlane(db, lanes[0]!.id, { defaultAssigneeAgent: null });
    expect(updated.defaultAssigneeAgent).toBeNull();
    db.close();
  });

  test("create and update swimlane color", async () => {
    const db = await newDb();
    createProject(db, { name: "alpha" });
    const lane = createSwimlane(db, { project: "alpha", name: "Colored", color: "#6366f1" });
    expect(lane.color).toBe("#6366f1");
    const updated = updateSwimlane(db, lane.id, { color: "#ef4444" });
    expect(updated.color).toBe("#ef4444");
    const cleared = updateSwimlane(db, lane.id, { color: null });
    expect(cleared.color).toBeNull();
    db.close();
  });

  test("create and update swimlane group", async () => {
    const db = await newDb();
    createProject(db, { name: "alpha" });
    const lane1 = createSwimlane(db, { project: "alpha", name: "Plan", group: "agent-workflow" });
    const lane2 = createSwimlane(db, { project: "alpha", name: "Review", group: "agent-workflow" });
    expect(lane1.group).toBe("agent-workflow");
    expect(lane2.group).toBe("agent-workflow");
    const updated = updateSwimlane(db, lane1.id, { group: "other" });
    expect(updated.group).toBe("other");
    const cleared = updateSwimlane(db, lane1.id, { group: null });
    expect(cleared.group).toBeNull();
    db.close();
  });

  test("default lanes have no group", async () => {
    const db = await newDb();
    createProject(db, { name: "alpha" });
    const lanes = listSwimlanes(db, "alpha");
    for (const lane of lanes) {
      expect(lane.group).toBeNull();
    }
    db.close();
  });
});
