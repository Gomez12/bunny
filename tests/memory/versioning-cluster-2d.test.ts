/**
 * Phase 2d round-trip smoke tests — planning_project / planning_deadline /
 * planning_team / planning_tag / planning_wish. Each test seeds an entity,
 * mutates it, restores version 1, and asserts the registered snapshot/restore
 * pair reapplies the source-of-truth fields (and, for wishes, the tag M:N).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/memory/db.ts";
import { createProject } from "../../src/memory/projects.ts";
import {
  createPlanningProject,
  getPlanningProject,
  updatePlanningProject,
} from "../../src/memory/planning_projects.ts";
import {
  createDeadline,
  getDeadline,
  updateDeadline,
} from "../../src/memory/planning_deadlines.ts";
import {
  createTeam,
  getTeam,
  updateTeam,
} from "../../src/memory/planning_teams.ts";
import {
  createTag,
  getTag,
  updateTag,
} from "../../src/memory/planning_tags.ts";
import {
  createWish,
  getWish,
  updateWish,
} from "../../src/memory/planning_wishes.ts";
import {
  configureVersioning,
  recordVersion,
  restoreVersion,
} from "../../src/memory/versioning.ts";

let tmp: string;

async function setup() {
  tmp = mkdtempSync(join(tmpdir(), "bunny-versioning-2d-"));
  const db = await openDb(join(tmp, "test.sqlite"));
  const now = Date.now();
  db.run(
    `INSERT INTO users(id, username, password_hash, role, created_at, updated_at)
     VALUES ('alice', 'alice', 'x', 'admin', ?, ?)`,
    [now, now],
  );
  createProject(db, { name: "alpha", createdBy: "alice" });
  const pp = createPlanningProject(db, {
    project: "alpha",
    name: "roadmap",
    description: "",
    startDate: null,
    sprintDurationDays: null,
    createdBy: "alice",
  });
  return { db, ppId: pp.id };
}

beforeEach(() => {
  configureVersioning({ debounceMinutes: 0, maxSnapshotBytes: 1_048_576 });
});

afterEach(() => {
  configureVersioning({ debounceMinutes: 5, maxSnapshotBytes: 1_048_576 });
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("planning_project versioning", () => {
  test("restoreVersion reverts description + sprint cadence", async () => {
    const { db, ppId } = await setup();
    recordVersion(db, "planning_project", ppId, "save", "alice");

    updatePlanningProject(db, ppId, {
      description: "v2",
      sprintDurationDays: 10,
    });
    recordVersion(db, "planning_project", ppId, "save", "alice");

    restoreVersion(db, "planning_project", ppId, 1, "alice");
    const restored = getPlanningProject(db, ppId)!;
    expect(restored.description).toBe("");
    expect(restored.sprintDurationDays).toBeNull();
    db.close();
  });
});

describe("planning_deadline versioning", () => {
  test("restoreVersion reverts name + due_date", async () => {
    const { db, ppId } = await setup();
    const dl = createDeadline(db, {
      planningProjectId: ppId,
      project: "alpha",
      name: "M1",
      dueDate: "2026-06-01",
      createdBy: "alice",
    });
    recordVersion(db, "planning_deadline", dl.id, "save", "alice");

    updateDeadline(db, dl.id, { name: "M1-renamed", dueDate: "2026-07-01" });
    recordVersion(db, "planning_deadline", dl.id, "save", "alice");

    restoreVersion(db, "planning_deadline", dl.id, 1, "alice");
    const restored = getDeadline(db, dl.id)!;
    expect(restored.name).toBe("M1");
    expect(restored.dueDate).toBe("2026-06-01");
    db.close();
  });
});

describe("planning_team versioning", () => {
  test("restoreVersion reverts max_parallel + description", async () => {
    const { db, ppId } = await setup();
    const team = createTeam(db, {
      planningProjectId: ppId,
      project: "alpha",
      name: "core",
      description: "first",
      maxParallel: 1,
      createdBy: "alice",
    });
    recordVersion(db, "planning_team", team.id, "save", "alice");

    updateTeam(db, team.id, { description: "second", maxParallel: 3 });
    recordVersion(db, "planning_team", team.id, "save", "alice");

    restoreVersion(db, "planning_team", team.id, 1, "alice");
    const restored = getTeam(db, team.id)!;
    expect(restored.description).toBe("first");
    expect(restored.maxParallel).toBe(1);
    db.close();
  });
});

describe("planning_tag versioning", () => {
  test("restoreVersion reverts color + description", async () => {
    const { db, ppId } = await setup();
    const tag = createTag(db, {
      planningProjectId: ppId,
      project: "alpha",
      name: "frontend",
      description: "ui work",
      color: "#aaa",
      createdBy: "alice",
    });
    recordVersion(db, "planning_tag", tag.id, "save", "alice");

    updateTag(db, tag.id, { description: "rewritten", color: "#bbb" });
    recordVersion(db, "planning_tag", tag.id, "save", "alice");

    restoreVersion(db, "planning_tag", tag.id, 1, "alice");
    const restored = getTag(db, tag.id)!;
    expect(restored.description).toBe("ui work");
    expect(restored.color).toBe("#aaa");
    db.close();
  });
});

describe("planning_wish versioning", () => {
  test("restoreVersion reverts title + tag membership", async () => {
    const { db, ppId } = await setup();
    const tagA = createTag(db, {
      planningProjectId: ppId,
      project: "alpha",
      name: "alpha-tag",
      createdBy: "alice",
    });
    const tagB = createTag(db, {
      planningProjectId: ppId,
      project: "alpha",
      name: "beta-tag",
      createdBy: "alice",
    });
    const wish = createWish(db, {
      planningProjectId: ppId,
      project: "alpha",
      title: "Ship feature",
      description: "first",
      tagIds: [tagA.id],
      createdBy: "alice",
    });
    recordVersion(db, "planning_wish", wish.id, "save", "alice");

    updateWish(db, wish.id, {
      title: "Ship feature v2",
      description: "second",
      tagIds: [tagB.id],
    });
    recordVersion(db, "planning_wish", wish.id, "save", "alice");

    restoreVersion(db, "planning_wish", wish.id, 1, "alice");
    const restored = getWish(db, wish.id)!;
    expect(restored.title).toBe("Ship feature");
    expect(restored.description).toBe("first");
    // Tag set is part of the wish snapshot — restore must rebuild it.
    expect(restored.tagIds).toEqual([tagA.id]);
    db.close();
  });
});
