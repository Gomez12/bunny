import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/memory/db.ts";
import { createProject } from "../../src/memory/projects.ts";
import {
  createPlanningProject,
  deletePlanningProject,
  getPlanningProject,
  listPlanningProjects,
  validatePlanningProjectName,
} from "../../src/memory/planning_projects.ts";
import {
  createDeadline,
  listDeadlines,
} from "../../src/memory/planning_deadlines.ts";
import {
  addTeamMember,
  createTeam,
  deleteTeam,
  listTeamMembers,
  listTeams,
  updateTeam,
} from "../../src/memory/planning_teams.ts";
import {
  createTag,
  listTags,
} from "../../src/memory/planning_tags.ts";
import {
  applyPlacements,
  createWish,
  deleteWish,
  listWishes,
  updateWish,
} from "../../src/memory/planning_wishes.ts";
import {
  acceptPending,
  getPendingSuggestion,
  rejectPending,
  replacePending,
  selectStalePlanningProjectIds,
} from "../../src/memory/planning_suggestions.ts";
import { listTrash, restore } from "../../src/memory/trash.ts";

let tmp: string;

async function setup() {
  tmp = mkdtempSync(join(tmpdir(), "bunny-planning-"));
  const db = await openDb(join(tmp, "test.sqlite"));
  const now = Date.now();
  db.run(
    `INSERT INTO users(id, username, password_hash, role, created_at, updated_at)
     VALUES ('owner', 'owner', 'x', 'admin', ?, ?)`,
    [now, now],
  );
  createProject(db, { name: "alpha", createdBy: "owner" });
  return { db };
}

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("planning_projects", () => {
  test("validates slug names", () => {
    expect(validatePlanningProjectName("q1-roadmap")).toBe("q1-roadmap");
    expect(() => validatePlanningProjectName("../escape")).toThrow();
    expect(() => validatePlanningProjectName("UPPER")).not.toThrow();
  });

  test("CRUD round-trip + UNIQUE per Bunny project", async () => {
    const { db } = await setup();
    const pp = createPlanningProject(db, {
      project: "alpha",
      name: "q1",
      description: "First quarter",
      createdBy: "owner",
    });
    expect(pp.id).toBeGreaterThan(0);
    expect(pp.name).toBe("q1");
    const list = listPlanningProjects(db, "alpha");
    expect(list.length).toBe(1);
    expect(getPlanningProject(db, pp.id)?.description).toBe("First quarter");
    // Duplicate name in same project rejected.
    expect(() =>
      createPlanningProject(db, {
        project: "alpha",
        name: "q1",
        createdBy: "owner",
      }),
    ).toThrow();
  });

  test("sprint duration round-trips and clamps invalid values to null", async () => {
    const { db } = await setup();
    const pp = createPlanningProject(db, {
      project: "alpha",
      name: "sprintp",
      sprintDurationDays: 10,
      createdBy: "owner",
    });
    expect(pp.sprintDurationDays).toBe(10);
    // Update to bi-weekly cadence.
    const updated = (await import("../../src/memory/planning_projects.ts"))
      .updatePlanningProject(db, pp.id, { sprintDurationDays: 5 });
    expect(updated.sprintDurationDays).toBe(5);
    // Clear by passing null.
    const cleared = (await import("../../src/memory/planning_projects.ts"))
      .updatePlanningProject(db, pp.id, { sprintDurationDays: null });
    expect(cleared.sprintDurationDays).toBeNull();
    // Garbage values clamp to null.
    const garbage = (await import("../../src/memory/planning_projects.ts"))
      .updatePlanningProject(db, pp.id, {
        sprintDurationDays: -3 as unknown as number,
      });
    expect(garbage.sprintDurationDays).toBeNull();
  });

  test("soft-delete renames + restores cleanly", async () => {
    const { db } = await setup();
    const pp = createPlanningProject(db, {
      project: "alpha",
      name: "q1",
      createdBy: "owner",
    });
    deletePlanningProject(db, pp.id, "owner");
    expect(getPlanningProject(db, pp.id)).toBeNull();
    expect(listTrash(db).find((t) => t.id === pp.id)?.name).toBe("q1");
    const outcome = restore(db, "planning_project", pp.id);
    expect(outcome).toBe("ok");
    expect(getPlanningProject(db, pp.id)?.name).toBe("q1");
  });
});

describe("planning_teams", () => {
  test("members add/remove/list", async () => {
    const { db } = await setup();
    const pp = createPlanningProject(db, {
      project: "alpha",
      name: "q1",
      createdBy: "owner",
    });
    const team = createTeam(db, {
      planningProjectId: pp.id,
      project: "alpha",
      name: "backend",
      maxParallel: 2,
      createdBy: "owner",
      members: ["owner"],
    });
    expect(team.maxParallel).toBe(2);
    expect(team.members).toEqual(["owner"]);
    const now = Date.now();
    db.run(
      `INSERT INTO users(id, username, password_hash, role, created_at, updated_at)
       VALUES ('alice', 'alice', 'x', 'user', ?, ?)`,
      [now, now],
    );
    addTeamMember(db, team.id, "alice");
    expect(listTeamMembers(db, team.id).sort()).toEqual(["alice", "owner"]);
    // Update team max_parallel.
    const updated = updateTeam(db, team.id, { maxParallel: 5 });
    expect(updated.maxParallel).toBe(5);
    // Soft-delete + restore preserves uniqueness scope.
    deleteTeam(db, team.id, "owner");
    expect(listTeams(db, pp.id).length).toBe(0);
    expect(restore(db, "planning_team", team.id)).toBe("ok");
    expect(listTeams(db, pp.id).length).toBe(1);
  });
});

describe("planning_wishes", () => {
  test("jiraKey is trimmed, persisted, and clearable to null", async () => {
    const { db } = await setup();
    const pp = createPlanningProject(db, {
      project: "alpha",
      name: "q1",
      createdBy: "owner",
    });
    const w = createWish(db, {
      planningProjectId: pp.id,
      project: "alpha",
      title: "With Jira",
      jiraKey: "  PROJ-123  ",
      createdBy: "owner",
    });
    expect(w.jiraKey).toBe("PROJ-123");
    const cleared = updateWish(db, w.id, { jiraKey: "" });
    expect(cleared.jiraKey).toBeNull();
    const reset = updateWish(db, w.id, { jiraKey: "BUNNY-9" });
    expect(reset.jiraKey).toBe("BUNNY-9");
    const cleared2 = updateWish(db, w.id, { jiraKey: null });
    expect(cleared2.jiraKey).toBeNull();
    // Too long → throws.
    expect(() =>
      updateWish(db, w.id, { jiraKey: "X".repeat(65) }),
    ).toThrow();
  });

  test("CRUD + tag M:N + dependency JSON round-trip", async () => {
    const { db } = await setup();
    const pp = createPlanningProject(db, {
      project: "alpha",
      name: "q1",
      createdBy: "owner",
    });
    const tag = createTag(db, {
      planningProjectId: pp.id,
      project: "alpha",
      name: "infra",
      createdBy: "owner",
    });
    const team = createTeam(db, {
      planningProjectId: pp.id,
      project: "alpha",
      name: "backend",
      createdBy: "owner",
    });
    const w1 = createWish(db, {
      planningProjectId: pp.id,
      project: "alpha",
      title: "Set up DB",
      durationDays: 3,
      teamId: team.id,
      tagIds: [tag.id],
      createdBy: "owner",
    });
    const w2 = createWish(db, {
      planningProjectId: pp.id,
      project: "alpha",
      title: "Add auth",
      durationDays: 2,
      teamId: team.id,
      dependsOnWishes: [w1.id],
      dependsOnTags: ["infra"],
      createdBy: "owner",
    });
    const list = listWishes(db, pp.id);
    expect(list.length).toBe(2);
    const reloaded = list.find((x) => x.id === w2.id)!;
    expect(reloaded.dependsOnWishes).toEqual([w1.id]);
    expect(reloaded.dependsOnTags).toEqual(["infra"]);
    expect(list.find((x) => x.id === w1.id)?.tagIds).toEqual([tag.id]);
    // Update changes tag set.
    const updated = updateWish(db, w1.id, { tagIds: [] });
    expect(updated.tagIds).toEqual([]);
    // applyPlacements writes start/end and reports changed ids.
    const changed = applyPlacements(db, [
      { wishId: w1.id, start: "2026-01-05", end: "2026-01-07" },
    ]);
    expect(changed).toEqual([w1.id]);
    const w1After = listWishes(db, pp.id).find((x) => x.id === w1.id)!;
    expect(w1After.plannedStartDate).toBe("2026-01-05");
    expect(w1After.plannedEndDate).toBe("2026-01-07");
    // Soft-delete sticks.
    deleteWish(db, w1.id, "owner");
    expect(listWishes(db, pp.id).find((x) => x.id === w1.id)).toBeUndefined();
  });
});

describe("planning_deadlines + tags", () => {
  test("create + list both", async () => {
    const { db } = await setup();
    const pp = createPlanningProject(db, {
      project: "alpha",
      name: "q1",
      createdBy: "owner",
    });
    createDeadline(db, {
      planningProjectId: pp.id,
      project: "alpha",
      name: "Launch",
      dueDate: "2026-03-01",
      createdBy: "owner",
    });
    createTag(db, {
      planningProjectId: pp.id,
      project: "alpha",
      name: "ui",
      createdBy: "owner",
    });
    expect(listDeadlines(db, pp.id).length).toBe(1);
    expect(listTags(db, pp.id).length).toBe(1);
  });

  test("invalid due_date is rejected", async () => {
    const { db } = await setup();
    const pp = createPlanningProject(db, {
      project: "alpha",
      name: "q1",
      createdBy: "owner",
    });
    expect(() =>
      createDeadline(db, {
        planningProjectId: pp.id,
        project: "alpha",
        name: "bad",
        dueDate: "March 1, 2026",
        createdBy: "owner",
      }),
    ).toThrow();
  });
});

describe("planning_suggestions", () => {
  test("replace pending and accept/reject lifecycle", async () => {
    const { db } = await setup();
    const pp = createPlanningProject(db, {
      project: "alpha",
      name: "q1",
      createdBy: "owner",
    });
    const first = replacePending(
      db,
      pp.id,
      { placements: [], bottlenecks: [] },
      "owner",
    );
    expect(first.status).toBe("pending");
    // A second replace should drop the first pending row.
    const second = replacePending(
      db,
      pp.id,
      {
        placements: [{ wishId: 1, start: "2026-01-05", end: "2026-01-06" }],
        bottlenecks: [],
      },
      "owner",
    );
    expect(second.id).not.toBe(first.id);
    expect(getPendingSuggestion(db, pp.id)?.id).toBe(second.id);
    // Accept moves it out of pending.
    acceptPending(db, pp.id, "owner", "looks good");
    expect(getPendingSuggestion(db, pp.id)).toBeNull();
    // Reject when there's no pending returns null.
    expect(rejectPending(db, pp.id, "owner")).toBeNull();
  });

  test("selectStalePlanningProjectIds finds no-pending and outdated", async () => {
    const { db } = await setup();
    const pp = createPlanningProject(db, {
      project: "alpha",
      name: "q1",
      createdBy: "owner",
    });
    // No suggestion → stale.
    expect(selectStalePlanningProjectIds(db, 10)).toContain(pp.id);
    replacePending(db, pp.id, { placements: [], bottlenecks: [] }, null);
    // After a replace, no edits → not stale.
    expect(selectStalePlanningProjectIds(db, 10)).not.toContain(pp.id);
    // Forcing a wish update marks stale again.
    await new Promise((r) => setTimeout(r, 5));
    createWish(db, {
      planningProjectId: pp.id,
      project: "alpha",
      title: "x",
      createdBy: "owner",
    });
    expect(selectStalePlanningProjectIds(db, 10)).toContain(pp.id);
  });
});
