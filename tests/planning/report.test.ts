import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../../src/memory/db.ts";
import { createProject } from "../../src/memory/projects.ts";
import { createPlanningProject } from "../../src/memory/planning_projects.ts";
import { createTeam } from "../../src/memory/planning_teams.ts";
import { createDeadline } from "../../src/memory/planning_deadlines.ts";
import { createTag } from "../../src/memory/planning_tags.ts";
import {
  applyPlacements,
  createWish,
  updateWish,
} from "../../src/memory/planning_wishes.ts";
import {
  buildReportPayload,
  renderReportMarkdown,
  type ReportPayload,
} from "../../src/planning/report.ts";

let tmp: string;
let db: Database;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "bunny-report-"));
  db = await openDb(join(tmp, "test.sqlite"));
  const now = Date.now();
  db.run(
    `INSERT INTO users(id, username, password_hash, role, created_at, updated_at)
     VALUES ('owner', 'owner', 'x', 'admin', ?, ?)`,
    [now, now],
  );
  createProject(db, { name: "alpha", createdBy: "owner" });
});

afterEach(() => {
  db.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const PINNED_NOW = new Date("2026-01-05T12:00:00Z").getTime(); // Monday

describe("buildReportPayload", () => {
  test("empty planning project returns no_data", () => {
    const pp = createPlanningProject(db, {
      project: "alpha",
      name: "q1",
      createdBy: "owner",
    });
    const payload = buildReportPayload(db, pp.id, { now: PINNED_NOW })!;
    expect(payload.summary.overallStatus).toBe("no_data");
    expect(payload.summary.totals.wishes).toBe(0);
  });

  test("on_track when everything fits inside its deadline", () => {
    const pp = createPlanningProject(db, {
      project: "alpha",
      name: "q1",
      startDate: "2026-01-05",
      createdBy: "owner",
    });
    const team = createTeam(db, {
      planningProjectId: pp.id,
      project: "alpha",
      name: "backend",
      createdBy: "owner",
    });
    const dl = createDeadline(db, {
      planningProjectId: pp.id,
      project: "alpha",
      name: "MVP",
      dueDate: "2026-03-01",
      createdBy: "owner",
    });
    const w = createWish(db, {
      planningProjectId: pp.id,
      project: "alpha",
      title: "Build it",
      durationDays: 5,
      teamId: team.id,
      deadlineId: dl.id,
      createdBy: "owner",
    });
    applyPlacements(db, [
      { wishId: w.id, start: "2026-01-05", end: "2026-01-09" },
    ]);
    const payload = buildReportPayload(db, pp.id, { now: PINNED_NOW })!;
    expect(payload.summary.overallStatus).toBe("on_track");
    expect(payload.deadlines[0]!.status).toBe("on_track");
    expect(payload.deadlines[0]!.wishesAtRisk).toBe(0);
  });

  test("at_risk when a wish ends after its deadline", () => {
    const pp = createPlanningProject(db, {
      project: "alpha",
      name: "q1",
      startDate: "2026-01-05",
      createdBy: "owner",
    });
    const team = createTeam(db, {
      planningProjectId: pp.id,
      project: "alpha",
      name: "backend",
      createdBy: "owner",
    });
    const dl = createDeadline(db, {
      planningProjectId: pp.id,
      project: "alpha",
      name: "Tight",
      dueDate: "2026-01-08",
      createdBy: "owner",
    });
    const w = createWish(db, {
      planningProjectId: pp.id,
      project: "alpha",
      title: "Big work",
      durationDays: 5,
      teamId: team.id,
      deadlineId: dl.id,
      createdBy: "owner",
    });
    applyPlacements(db, [
      { wishId: w.id, start: "2026-01-05", end: "2026-01-12" },
    ]);
    const payload = buildReportPayload(db, pp.id, { now: PINNED_NOW })!;
    expect(payload.summary.overallStatus).toBe("slipping");
    expect(payload.deadlines[0]!.status).toBe("at_risk");
    expect(payload.deadlines[0]!.worstOverrunDays).toBeGreaterThan(0);
    expect(payload.risks.find((r) => r.kind === "deadline_overrun")).toBeDefined();
  });

  test("missed when due date passed and wishes are not done", () => {
    const pp = createPlanningProject(db, {
      project: "alpha",
      name: "q1",
      startDate: "2026-01-05",
      createdBy: "owner",
    });
    const dl = createDeadline(db, {
      planningProjectId: pp.id,
      project: "alpha",
      name: "Past",
      dueDate: "2025-12-01",
      createdBy: "owner",
    });
    createWish(db, {
      planningProjectId: pp.id,
      project: "alpha",
      title: "Open",
      durationDays: 1,
      deadlineId: dl.id,
      createdBy: "owner",
    });
    const payload = buildReportPayload(db, pp.id, { now: PINNED_NOW })!;
    expect(payload.deadlines[0]!.status).toBe("missed");
    expect(payload.summary.totals.deadlinesMissed).toBe(1);
  });

  test("gaps surface unscheduled / no-team / no-deadline wishes", () => {
    const pp = createPlanningProject(db, {
      project: "alpha",
      name: "q1",
      createdBy: "owner",
    });
    createWish(db, {
      planningProjectId: pp.id,
      project: "alpha",
      title: "Floating",
      durationDays: 3,
      createdBy: "owner",
    });
    const payload = buildReportPayload(db, pp.id, { now: PINNED_NOW })!;
    expect(payload.gaps.wishesWithoutTeam).toHaveLength(1);
    expect(payload.gaps.wishesWithoutDeadline).toHaveLength(1);
    expect(payload.gaps.unscheduledWishes).toHaveLength(1);
    expect(payload.risks.find((r) => r.kind === "no_team")).toBeDefined();
    expect(payload.risks.find((r) => r.kind === "no_deadline")).toBeDefined();
    expect(payload.risks.find((r) => r.kind === "no_start_date")).toBeDefined();
  });

  test("comparison summarises deltas vs. previous payload", () => {
    const pp = createPlanningProject(db, {
      project: "alpha",
      name: "q1",
      startDate: "2026-01-05",
      createdBy: "owner",
    });
    const team = createTeam(db, {
      planningProjectId: pp.id,
      project: "alpha",
      name: "x",
      createdBy: "owner",
    });
    const w1 = createWish(db, {
      planningProjectId: pp.id,
      project: "alpha",
      title: "Done one",
      durationDays: 1,
      teamId: team.id,
      createdBy: "owner",
    });
    createWish(db, {
      planningProjectId: pp.id,
      project: "alpha",
      title: "Open two",
      durationDays: 1,
      teamId: team.id,
      createdBy: "owner",
    });
    const before = buildReportPayload(db, pp.id, { now: PINNED_NOW })!;
    // Mark one done, then build the next snapshot with `previous` set.
    updateWish(db, w1.id, { status: "done" });
    const after = buildReportPayload(db, pp.id, {
      now: PINNED_NOW + 1000,
      previous: before,
      previousReportId: 1,
      previousGeneratedAt: PINNED_NOW,
    })!;
    expect(after.comparison).toBeDefined();
    expect(after.comparison!.deltaWishesDone).toBe(1);
  });

  test("renderReportMarkdown produces a non-empty document with headings", () => {
    const pp = createPlanningProject(db, {
      project: "alpha",
      name: "q1",
      createdBy: "owner",
    });
    const team = createTeam(db, {
      planningProjectId: pp.id,
      project: "alpha",
      name: "team",
      createdBy: "owner",
    });
    const dl = createDeadline(db, {
      planningProjectId: pp.id,
      project: "alpha",
      name: "MVP",
      dueDate: "2026-03-01",
      createdBy: "owner",
    });
    createWish(db, {
      planningProjectId: pp.id,
      project: "alpha",
      title: "Ship it",
      durationDays: 2,
      teamId: team.id,
      deadlineId: dl.id,
      createdBy: "owner",
    });
    const payload = buildReportPayload(db, pp.id, { now: PINNED_NOW }) as
      | ReportPayload
      | null;
    expect(payload).not.toBeNull();
    const md = renderReportMarkdown(payload!, { generatedBy: "Test" });
    expect(md).toContain("# Roadmap status — q1");
    expect(md).toContain("## Executive summary");
    expect(md).toContain("## Deadlines");
    expect(md).toContain("## Risks");
    expect(md).toContain("## Coverage gaps");
    expect(md).toContain("## Upcoming");
    expect(md).toContain("Ship it");
  });
});
