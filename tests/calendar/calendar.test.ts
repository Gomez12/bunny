import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../../src/memory/db.ts";
import {
  bulkInsertHolidays,
  buildNonWorkingDateSet,
  createGlobalException,
  createPlanningException,
  createProjectException,
  createTeamException,
  createUserException,
  deleteException,
  getException,
  isWorkingDay,
  listGlobalExceptions,
  listTeamExceptions,
  listUserExceptions,
  resolveWorkingDay,
  updateException,
} from "../../src/memory/calendar.ts";
import { openDb as _openDb } from "../../src/memory/db.ts";

let tmp: string;
let db: Database;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "bunny-calendar-test-"));
  db = await openDb(join(tmp, "test.db"));
  // Seed required FK targets.
  const now = Date.now();
  db.run(
    `INSERT OR IGNORE INTO projects(name, description, visibility, created_by, created_at, updated_at)
     VALUES ('proj', 'Test project', 'public', NULL, ?, ?)`,
    [now, now],
  );
  db.run(
    `INSERT OR IGNORE INTO users(id, username, display_name, role, password_hash, created_at, updated_at)
     VALUES ('user1', 'user1', 'User One', 'user', 'x', ?, ?)`,
    [now, now],
  );
  db.run(
    `INSERT OR IGNORE INTO planning_projects(project, name, start_date, created_by, created_at, updated_at)
     VALUES ('proj', 'Plan A', '2026-01-01', 'user1', ?, ?)`,
    [now, now],
  );
  // Get the planning_project id.
  const ppRow = db
    .query<{ id: number }, []>(
      `SELECT id FROM planning_projects WHERE name = 'Plan A' LIMIT 1`,
    )
    .get();
  if (ppRow) {
    db.run(
      `INSERT OR IGNORE INTO planning_teams(planning_project_id, project, name, max_parallel, created_by, created_at, updated_at)
       VALUES (?, 'proj', 'Alpha', 2, 'user1', ?, ?)`,
      [ppRow.id, now, now],
    );
  }
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

function ppId(): number {
  return db
    .query<{ id: number }, []>(
      `SELECT id FROM planning_projects LIMIT 1`,
    )
    .get()!.id;
}

function teamId(): number {
  return db
    .query<{ id: number }, []>(
      `SELECT id FROM planning_teams LIMIT 1`,
    )
    .get()!.id;
}

// ── createGlobalException / listGlobalExceptions ─────────────────────────────

describe("createGlobalException / listGlobalExceptions", () => {
  test("inserts and retrieves a non_working day", () => {
    createGlobalException(db, {
      date: "2026-12-25",
      kind: "non_working",
      name: "Christmas",
      createdBy: "user1",
    });
    const list = listGlobalExceptions(db);
    expect(list).toHaveLength(1);
    expect(list[0]!.date).toBe("2026-12-25");
    expect(list[0]!.kind).toBe("non_working");
    expect(list[0]!.name).toBe("Christmas");
  });

  test("inserts and retrieves a workable override", () => {
    createGlobalException(db, {
      date: "2026-01-03",
      kind: "workable",
      name: "Special Saturday",
      createdBy: "user1",
    });
    const list = listGlobalExceptions(db);
    expect(list[0]!.kind).toBe("workable");
  });

  test("throws on duplicate date within global manual scope", () => {
    createGlobalException(db, { date: "2026-12-25", kind: "non_working", createdBy: "user1" });
    expect(() =>
      createGlobalException(db, { date: "2026-12-25", kind: "workable", createdBy: "user1" }),
    ).toThrow();
  });

  test("manual and auto_holiday can coexist on the same date", () => {
    createGlobalException(db, {
      date: "2026-12-25",
      kind: "non_working",
      name: "Christmas manual",
      createdBy: "user1",
    });
    bulkInsertHolidays(db, [{ date: "2026-12-25", name: "Christmas auto" }], {
      userId: "user1",
      countryCode: "NL",
    });
    const list = listGlobalExceptions(db);
    expect(list).toHaveLength(2);
    const sources = list.map((e) => e.source).sort();
    expect(sources).toEqual(["auto_holiday", "manual"]);
  });
});

// ── Scoped exceptions ─────────────────────────────────────────────────────────

describe("scoped exceptions", () => {
  test("project exception unique index blocks duplicate (project, date)", () => {
    createProjectException(db, "proj", { date: "2026-06-01", kind: "non_working", createdBy: "user1" });
    expect(() =>
      createProjectException(db, "proj", { date: "2026-06-01", kind: "workable", createdBy: "user1" }),
    ).toThrow();
  });

  test("different scopes are independent for the same date", () => {
    const pp = ppId();
    const tm = teamId();
    createGlobalException(db, { date: "2026-06-01", kind: "non_working", createdBy: "user1" });
    createProjectException(db, "proj", { date: "2026-06-01", kind: "non_working", createdBy: "user1" });
    createPlanningException(db, pp, { date: "2026-06-01", kind: "non_working", createdBy: "user1" });
    createTeamException(db, tm, pp, { date: "2026-06-01", kind: "non_working", createdBy: "user1" });
    createUserException(db, "user1", { date: "2026-06-01", kind: "non_working", createdBy: "user1" });
    // Five rows created — one per scope.
    const count = db
      .query<{ n: number }, []>(
        `SELECT COUNT(*) AS n FROM calendar_exceptions WHERE date = '2026-06-01'`,
      )
      .get()!.n;
    expect(count).toBe(5);
  });
});

// ── deleteException (soft delete) ────────────────────────────────────────────

describe("deleteException (soft delete)", () => {
  test("sets deleted_at, row excluded from list queries", () => {
    const exc = createGlobalException(db, {
      date: "2026-03-10",
      kind: "non_working",
      createdBy: "user1",
    });
    deleteException(db, exc.id, "user1");
    expect(listGlobalExceptions(db)).toHaveLength(0);
  });

  test("allows re-add after soft delete", () => {
    const exc = createGlobalException(db, {
      date: "2026-03-10",
      kind: "non_working",
      createdBy: "user1",
    });
    deleteException(db, exc.id, "user1");
    // Should not throw.
    createGlobalException(db, { date: "2026-03-10", kind: "workable", createdBy: "user1" });
    expect(listGlobalExceptions(db)).toHaveLength(1);
  });
});

// ── updateException ───────────────────────────────────────────────────────────

describe("updateException", () => {
  test("updates kind and name", () => {
    const exc = createGlobalException(db, {
      date: "2026-04-01",
      kind: "non_working",
      name: "Old",
      createdBy: "user1",
    });
    const updated = updateException(db, exc.id, { kind: "workable", name: "New" });
    expect(updated.kind).toBe("workable");
    expect(updated.name).toBe("New");
  });

  test("getException returns the row", () => {
    const exc = createGlobalException(db, {
      date: "2026-04-02",
      kind: "non_working",
      createdBy: "user1",
    });
    const fetched = getException(db, exc.id);
    expect(fetched?.id).toBe(exc.id);
  });

  test("getException returns null for deleted row", () => {
    const exc = createGlobalException(db, {
      date: "2026-04-03",
      kind: "non_working",
      createdBy: "user1",
    });
    deleteException(db, exc.id, "user1");
    expect(getException(db, exc.id)).toBeNull();
  });
});

// ── bulkInsertHolidays ────────────────────────────────────────────────────────

describe("bulkInsertHolidays", () => {
  test("inserts N holidays and returns count", () => {
    const count = bulkInsertHolidays(
      db,
      [
        { date: "2026-01-01", name: "New Year" },
        { date: "2026-12-25", name: "Christmas" },
      ],
      { userId: "user1", countryCode: "NL" },
    );
    expect(count).toBe(2);
    expect(listGlobalExceptions(db)).toHaveLength(2);
  });

  test("replaces existing auto_holiday on same (date, country_code)", () => {
    bulkInsertHolidays(db, [{ date: "2026-12-25", name: "Christmas OLD" }], {
      userId: "user1",
      countryCode: "NL",
    });
    bulkInsertHolidays(db, [{ date: "2026-12-25", name: "Christmas NEW" }], {
      userId: "user1",
      countryCode: "NL",
    });
    const list = listGlobalExceptions(db);
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe("Christmas NEW");
  });

  test("auto_holiday for different country codes coexist on same date", () => {
    bulkInsertHolidays(db, [{ date: "2026-12-25", name: "Christmas NL" }], {
      userId: "user1",
      countryCode: "NL",
    });
    bulkInsertHolidays(db, [{ date: "2026-12-25", name: "Christmas BE" }], {
      userId: "user1",
      countryCode: "BE",
    });
    const list = listGlobalExceptions(db);
    expect(list).toHaveLength(2);
  });

  test("skips entries with invalid date format", () => {
    const count = bulkInsertHolidays(
      db,
      [
        { date: "not-a-date", name: "Bad" },
        { date: "2026-01-01", name: "Good" },
      ],
      { userId: "user1", countryCode: "NL" },
    );
    // count = 2 (we count loop iterations, not insertions for invalid)
    // What matters is that the bad date row is NOT inserted.
    const list = listGlobalExceptions(db);
    expect(list.every((e) => e.date !== "not-a-date")).toBe(true);
    expect(list.some((e) => e.date === "2026-01-01")).toBe(true);
  });
});

// ── resolveWorkingDay — defaults ──────────────────────────────────────────────

describe("resolveWorkingDay — defaults (no exceptions)", () => {
  test("Monday is workable by default", () => {
    const r = resolveWorkingDay(db, "2026-01-05", {}); // Monday
    expect(r.workable).toBe(true);
    expect(r.effectiveScope).toBe("weekday_default");
  });

  test("Saturday is non-working by default", () => {
    const r = resolveWorkingDay(db, "2026-01-03", {}); // Saturday
    expect(r.workable).toBe(false);
    expect(r.effectiveScope).toBe("weekend");
  });

  test("Sunday is non-working by default", () => {
    const r = resolveWorkingDay(db, "2026-01-04", {}); // Sunday
    expect(r.workable).toBe(false);
    expect(r.effectiveScope).toBe("weekend");
  });
});

// ── resolveWorkingDay — global layer ──────────────────────────────────────────

describe("resolveWorkingDay — global layer", () => {
  test("global non_working overrides weekday default", () => {
    createGlobalException(db, {
      date: "2026-01-05",
      kind: "non_working",
      name: "Company holiday",
      createdBy: "user1",
    });
    const r = resolveWorkingDay(db, "2026-01-05", {}); // Monday
    expect(r.workable).toBe(false);
    expect(r.effectiveScope).toBe("global");
    expect(r.reason).toBe("Company holiday");
  });

  test("global workable overrides weekend default", () => {
    createGlobalException(db, {
      date: "2026-01-03",
      kind: "workable",
      name: "Emergency Saturday",
      createdBy: "user1",
    });
    const r = resolveWorkingDay(db, "2026-01-03", {}); // Saturday
    expect(r.workable).toBe(true);
    expect(r.effectiveScope).toBe("global");
  });
});

// ── resolveWorkingDay — scope priority ────────────────────────────────────────

describe("resolveWorkingDay — scope priority", () => {
  test("user workable beats team non_working on same date", () => {
    const pp = ppId();
    const tm = teamId();
    // Team marks 2026-01-05 (Monday) as non_working.
    createTeamException(db, tm, pp, {
      date: "2026-01-05",
      kind: "non_working",
      name: "Team training",
      createdBy: "user1",
    });
    // User marks same day as workable.
    createUserException(db, "user1", {
      date: "2026-01-05",
      kind: "workable",
      name: "I will work",
      createdBy: "user1",
    });
    const r = resolveWorkingDay(db, "2026-01-05", {
      planningTeamId: tm,
      userId: "user1",
    });
    expect(r.workable).toBe(true);
    expect(r.effectiveScope).toBe("user");
  });

  test("team non_working beats planning on same date", () => {
    const pp = ppId();
    const tm = teamId();
    createPlanningException(db, pp, {
      date: "2026-01-05",
      kind: "workable",
      name: "Planning override",
      createdBy: "user1",
    });
    createTeamException(db, tm, pp, {
      date: "2026-01-05",
      kind: "non_working",
      name: "Team day off",
      createdBy: "user1",
    });
    const r = resolveWorkingDay(db, "2026-01-05", {
      planningProjectId: pp,
      planningTeamId: tm,
    });
    expect(r.workable).toBe(false);
    expect(r.effectiveScope).toBe("team");
  });

  test("planning non_working beats project on same date", () => {
    const pp = ppId();
    createProjectException(db, "proj", {
      date: "2026-01-05",
      kind: "workable",
      name: "Project override",
      createdBy: "user1",
    });
    createPlanningException(db, pp, {
      date: "2026-01-05",
      kind: "non_working",
      name: "Planning sprint break",
      createdBy: "user1",
    });
    const r = resolveWorkingDay(db, "2026-01-05", {
      projectName: "proj",
      planningProjectId: pp,
    });
    expect(r.workable).toBe(false);
    expect(r.effectiveScope).toBe("planning");
  });

  test("project non_working beats global on same date", () => {
    createGlobalException(db, {
      date: "2026-01-05",
      kind: "workable",
      name: "Global override",
      createdBy: "user1",
    });
    createProjectException(db, "proj", {
      date: "2026-01-05",
      kind: "non_working",
      name: "Project closed",
      createdBy: "user1",
    });
    const r = resolveWorkingDay(db, "2026-01-05", { projectName: "proj" });
    expect(r.workable).toBe(false);
    expect(r.effectiveScope).toBe("project");
  });

  test("isWorkingDay returns correct boolean", () => {
    createGlobalException(db, {
      date: "2026-12-25",
      kind: "non_working",
      name: "Christmas",
      createdBy: "user1",
    });
    expect(isWorkingDay(db, "2026-12-25", {})).toBe(false);
    expect(isWorkingDay(db, "2026-12-24", {})).toBe(true); // Thursday
  });
});

// ── buildNonWorkingDateSet ────────────────────────────────────────────────────

describe("buildNonWorkingDateSet", () => {
  test("includes weekends in date range", () => {
    const set = buildNonWorkingDateSet(db, "2026-01-05", "2026-01-11", {});
    expect(set.has("2026-01-10")).toBe(true); // Saturday
    expect(set.has("2026-01-11")).toBe(true); // Sunday
    expect(set.has("2026-01-05")).toBe(false); // Monday
  });

  test("includes global exceptions in set", () => {
    createGlobalException(db, {
      date: "2026-01-07",
      kind: "non_working",
      name: "Wednesday off",
      createdBy: "user1",
    });
    const set = buildNonWorkingDateSet(db, "2026-01-05", "2026-01-09", {});
    expect(set.has("2026-01-07")).toBe(true);
    expect(set.has("2026-01-05")).toBe(false);
  });

  test("workable override removes weekend from set", () => {
    createGlobalException(db, {
      date: "2026-01-10",
      kind: "workable",
      name: "Saturday shift",
      createdBy: "user1",
    });
    const set = buildNonWorkingDateSet(db, "2026-01-05", "2026-01-11", {});
    expect(set.has("2026-01-10")).toBe(false); // Saturday explicitly marked workable
    expect(set.has("2026-01-11")).toBe(true); // Sunday still non-working
  });

  test("respects scope priority: user workable beats team non_working", () => {
    const pp = ppId();
    const tm = teamId();
    createTeamException(db, tm, pp, {
      date: "2026-01-07",
      kind: "non_working",
      createdBy: "user1",
    });
    createUserException(db, "user1", {
      date: "2026-01-07",
      kind: "workable",
      createdBy: "user1",
    });
    const set = buildNonWorkingDateSet(db, "2026-01-05", "2026-01-09", {
      planningTeamId: tm,
      userId: "user1",
    });
    expect(set.has("2026-01-07")).toBe(false); // user workable wins
  });
});
