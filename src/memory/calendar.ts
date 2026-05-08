/**
 * Calendar exceptions — multi-layer non-working/workable-override system.
 *
 * Five scopes, most-specific wins (user > team > planning > project > global).
 * A day not covered by any scope follows the default: Mon–Fri workable,
 * Sat–Sun non-working.
 *
 * kind='non_working' marks a day off; kind='workable' explicitly un-blocks a
 * day that a higher-scope exception marked non-working (e.g. an emergency
 * Saturday shift overriding a global weekend rule).
 *
 * See docs/adr/0044-calendar-exceptions.md.
 */

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ExceptionKind = "non_working" | "workable";
export type ExceptionSource = "manual" | "auto_holiday";
export type ExceptionScope =
  | "global"
  | "project"
  | "planning"
  | "team"
  | "user";

export interface CalendarException {
  id: number;
  date: string;
  kind: ExceptionKind;
  name: string;
  source: ExceptionSource;
  countryCode: string | null;
  projectName: string | null;
  planningProjectId: number | null;
  planningTeamId: number | null;
  userId: string | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CalendarResolveCtx {
  projectName?: string | null;
  planningProjectId?: number | null;
  planningTeamId?: number | null;
  userId?: string | null;
}

export interface ResolveResult {
  workable: boolean;
  effectiveScope: ExceptionScope | "weekend" | "weekday_default";
  reason?: string;
}

export interface CreateGlobalExceptionOpts {
  date: string;
  kind: ExceptionKind;
  name?: string;
  source?: ExceptionSource;
  countryCode?: string | null;
  createdBy: string;
}

export interface CreateScopedExceptionOpts {
  date: string;
  kind: ExceptionKind;
  name?: string;
  createdBy: string;
}

export interface UpdateExceptionPatch {
  kind?: ExceptionKind;
  name?: string;
}

export interface HolidayInput {
  date: string;
  name: string;
}

// ── Row mapper ────────────────────────────────────────────────────────────────

interface Row {
  id: number;
  date: string;
  kind: string;
  name: string;
  source: string;
  country_code: string | null;
  project_name: string | null;
  planning_project_id: number | null;
  planning_team_id: number | null;
  user_id: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

function rowToException(r: Row): CalendarException {
  return {
    id: r.id,
    date: r.date,
    kind: r.kind as ExceptionKind,
    name: r.name,
    source: r.source as ExceptionSource,
    countryCode: r.country_code,
    projectName: r.project_name,
    planningProjectId: r.planning_project_id,
    planningTeamId: r.planning_team_id,
    userId: r.user_id,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const SELECT_COLS = `
  id, date, kind, name, source, country_code, project_name,
  planning_project_id, planning_team_id, user_id,
  created_by, created_at, updated_at
`;

// ── List ──────────────────────────────────────────────────────────────────────

export function listGlobalExceptions(db: Database): CalendarException[] {
  return (
    db
      .query<Row, []>(
        `SELECT ${SELECT_COLS} FROM calendar_exceptions
         WHERE project_name IS NULL AND planning_project_id IS NULL
           AND planning_team_id IS NULL AND user_id IS NULL
           AND deleted_at IS NULL
         ORDER BY date`,
      )
      .all() as Row[]
  ).map(rowToException);
}

export function listProjectExceptions(
  db: Database,
  projectName: string,
): CalendarException[] {
  return (
    db
      .query<Row, [string]>(
        `SELECT ${SELECT_COLS} FROM calendar_exceptions
         WHERE project_name = ? AND deleted_at IS NULL
         ORDER BY date`,
      )
      .all(projectName) as Row[]
  ).map(rowToException);
}

export function listPlanningExceptions(
  db: Database,
  planningProjectId: number,
): CalendarException[] {
  return (
    db
      .query<Row, [number]>(
        `SELECT ${SELECT_COLS} FROM calendar_exceptions
         WHERE planning_project_id = ? AND planning_team_id IS NULL
           AND user_id IS NULL AND deleted_at IS NULL
         ORDER BY date`,
      )
      .all(planningProjectId) as Row[]
  ).map(rowToException);
}

export function listTeamExceptions(
  db: Database,
  planningTeamId: number,
): CalendarException[] {
  return (
    db
      .query<Row, [number]>(
        `SELECT ${SELECT_COLS} FROM calendar_exceptions
         WHERE planning_team_id = ? AND user_id IS NULL AND deleted_at IS NULL
         ORDER BY date`,
      )
      .all(planningTeamId) as Row[]
  ).map(rowToException);
}

export function listUserExceptions(
  db: Database,
  userId: string,
): CalendarException[] {
  return (
    db
      .query<Row, [string]>(
        `SELECT ${SELECT_COLS} FROM calendar_exceptions
         WHERE user_id = ? AND deleted_at IS NULL
         ORDER BY date`,
      )
      .all(userId) as Row[]
  ).map(rowToException);
}

// ── Get ───────────────────────────────────────────────────────────────────────

export function getException(
  db: Database,
  id: number,
): CalendarException | null {
  const r = db
    .query<Row, [number]>(
      `SELECT ${SELECT_COLS} FROM calendar_exceptions
       WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(id) as Row | null;
  return r ? rowToException(r) : null;
}

// ── Create ────────────────────────────────────────────────────────────────────

export function createGlobalException(
  db: Database,
  opts: CreateGlobalExceptionOpts,
): CalendarException {
  const now = Date.now();
  const r = db
    .query<Row, [string, string, string, string, string | null, string, number, number]>(
      `INSERT INTO calendar_exceptions
         (date, kind, name, source, country_code, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING ${SELECT_COLS}`,
    )
    .get(
      opts.date,
      opts.kind,
      opts.name ?? "",
      opts.source ?? "manual",
      opts.countryCode ?? null,
      opts.createdBy,
      now,
      now,
    ) as Row;
  return rowToException(r);
}

export function createProjectException(
  db: Database,
  projectName: string,
  opts: CreateScopedExceptionOpts,
): CalendarException {
  const now = Date.now();
  const r = db
    .query<Row, [string, string, string, string, string, number, number]>(
      `INSERT INTO calendar_exceptions
         (date, kind, name, project_name, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       RETURNING ${SELECT_COLS}`,
    )
    .get(
      opts.date,
      opts.kind,
      opts.name ?? "",
      projectName,
      opts.createdBy,
      now,
      now,
    ) as Row;
  return rowToException(r);
}

export function createPlanningException(
  db: Database,
  planningProjectId: number,
  opts: CreateScopedExceptionOpts,
): CalendarException {
  const now = Date.now();
  const r = db
    .query<Row, [string, string, string, number, string, number, number]>(
      `INSERT INTO calendar_exceptions
         (date, kind, name, planning_project_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       RETURNING ${SELECT_COLS}`,
    )
    .get(
      opts.date,
      opts.kind,
      opts.name ?? "",
      planningProjectId,
      opts.createdBy,
      now,
      now,
    ) as Row;
  return rowToException(r);
}

export function createTeamException(
  db: Database,
  planningTeamId: number,
  planningProjectId: number,
  opts: CreateScopedExceptionOpts,
): CalendarException {
  const now = Date.now();
  const r = db
    .query<Row, [string, string, string, number, number, string, number, number]>(
      `INSERT INTO calendar_exceptions
         (date, kind, name, planning_team_id, planning_project_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING ${SELECT_COLS}`,
    )
    .get(
      opts.date,
      opts.kind,
      opts.name ?? "",
      planningTeamId,
      planningProjectId,
      opts.createdBy,
      now,
      now,
    ) as Row;
  return rowToException(r);
}

export function createUserException(
  db: Database,
  userId: string,
  opts: CreateScopedExceptionOpts,
): CalendarException {
  const now = Date.now();
  const r = db
    .query<Row, [string, string, string, string, string, number, number]>(
      `INSERT INTO calendar_exceptions
         (date, kind, name, user_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       RETURNING ${SELECT_COLS}`,
    )
    .get(
      opts.date,
      opts.kind,
      opts.name ?? "",
      userId,
      opts.createdBy,
      now,
      now,
    ) as Row;
  return rowToException(r);
}

// ── Update / Delete ───────────────────────────────────────────────────────────

export function updateException(
  db: Database,
  id: number,
  patch: UpdateExceptionPatch,
): CalendarException {
  const now = Date.now();
  const sets: string[] = ["updated_at = ?"];
  const vals: (string | number | null)[] = [now];

  if (patch.kind !== undefined) {
    sets.push("kind = ?");
    vals.push(patch.kind);
  }
  if (patch.name !== undefined) {
    sets.push("name = ?");
    vals.push(patch.name);
  }
  vals.push(id);

  const r = db
    .query<Row, (string | number | null)[]>(
      `UPDATE calendar_exceptions SET ${sets.join(", ")}
       WHERE id = ? AND deleted_at IS NULL
       RETURNING ${SELECT_COLS}`,
    )
    .get(...vals) as Row | null;
  if (!r) throw new Error(`calendar_exceptions ${id} not found`);
  return rowToException(r);
}

export function deleteException(
  db: Database,
  id: number,
  deletedBy: string,
): void {
  const now = Date.now();
  db.run(
    `UPDATE calendar_exceptions SET deleted_at = ?, deleted_by = ?
     WHERE id = ? AND deleted_at IS NULL`,
    [now, deletedBy, id],
  );
}

// ── Bulk holiday insert ───────────────────────────────────────────────────────

/**
 * Bulk-insert auto_holiday rows for a given country + year. Uses INSERT OR
 * REPLACE keyed on the (date, country_code) unique index. Never touches
 * manual rows (they live under a separate unique index). Returns count inserted.
 */
export function bulkInsertHolidays(
  db: Database,
  holidays: HolidayInput[],
  opts: { userId: string; countryCode: string },
): number {
  const now = Date.now();
  const stmt = db.prepare(
    `INSERT INTO calendar_exceptions
       (date, kind, name, source, country_code, created_by, created_at, updated_at)
     VALUES (?, 'non_working', ?, 'auto_holiday', ?, ?, ?, ?)
     ON CONFLICT(date, country_code)
       WHERE project_name IS NULL AND planning_project_id IS NULL
         AND planning_team_id IS NULL AND user_id IS NULL
         AND source = 'auto_holiday' AND deleted_at IS NULL
     DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
  );

  let count = 0;
  const tx = db.transaction(() => {
    for (const h of holidays) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(h.date)) continue;
      stmt.run(h.date, h.name, opts.countryCode, opts.userId, now, now);
      count++;
    }
  });
  tx();
  return count;
}

/**
 * Bulk-insert manual non_working rows for every Saturday and Sunday in `year`.
 * Uses INSERT OR IGNORE so existing manual rows on the same date are preserved
 * (including any existing name / kind). Returns the number of new rows inserted.
 */
export function bulkInsertWeekends(
  db: Database,
  year: number,
  createdBy: string,
): number {
  const now = Date.now();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO calendar_exceptions
       (date, kind, name, source, created_by, created_at, updated_at)
     VALUES (?, 'non_working', 'Weekend', 'manual', ?, ?, ?)`,
  );

  let count = 0;
  const tx = db.transaction(() => {
    const cursor = new Date(Date.UTC(year, 0, 1));
    while (cursor.getUTCFullYear() === year) {
      const dow = cursor.getUTCDay();
      if (dow === 0 || dow === 6) {
        const date = cursor.toISOString().slice(0, 10);
        const info = stmt.run(date, createdBy, now, now);
        if (info.changes > 0) count++;
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  });
  tx();
  return count;
}

// ── Core resolver ─────────────────────────────────────────────────────────────

function isWeekendDate(date: string): boolean {
  const d = new Date(`${date}T00:00:00Z`);
  const dow = d.getUTCDay();
  return dow === 0 || dow === 6;
}

interface KindRow {
  kind: string;
  name: string;
}

/**
 * Resolve whether a given date is a working day given the provided scope
 * context.
 *
 * Priority (most-specific first): user > team > planning > project > global.
 * The first scope that has a live exception for the date wins. Falls back to
 * the default weekday rule when no exceptions match.
 */
export function resolveWorkingDay(
  db: Database,
  date: string,
  ctx: CalendarResolveCtx,
): ResolveResult {
  // User scope
  if (ctx.userId) {
    const r = db
      .query<KindRow, [string, string]>(
        `SELECT kind, name FROM calendar_exceptions
         WHERE user_id = ? AND date = ? AND deleted_at IS NULL LIMIT 1`,
      )
      .get(ctx.userId, date);
    if (r) {
      return {
        workable: r.kind === "workable",
        effectiveScope: "user",
        reason: r.name || undefined,
      };
    }
  }

  // Team scope
  if (ctx.planningTeamId) {
    const r = db
      .query<KindRow, [number, string]>(
        `SELECT kind, name FROM calendar_exceptions
         WHERE planning_team_id = ? AND date = ? AND deleted_at IS NULL LIMIT 1`,
      )
      .get(ctx.planningTeamId, date);
    if (r) {
      return {
        workable: r.kind === "workable",
        effectiveScope: "team",
        reason: r.name || undefined,
      };
    }
  }

  // Planning scope
  if (ctx.planningProjectId) {
    const r = db
      .query<KindRow, [number, string]>(
        `SELECT kind, name FROM calendar_exceptions
         WHERE planning_project_id = ? AND planning_team_id IS NULL
           AND user_id IS NULL AND date = ? AND deleted_at IS NULL LIMIT 1`,
      )
      .get(ctx.planningProjectId, date);
    if (r) {
      return {
        workable: r.kind === "workable",
        effectiveScope: "planning",
        reason: r.name || undefined,
      };
    }
  }

  // Project scope
  if (ctx.projectName) {
    const r = db
      .query<KindRow, [string, string]>(
        `SELECT kind, name FROM calendar_exceptions
         WHERE project_name = ? AND date = ? AND deleted_at IS NULL LIMIT 1`,
      )
      .get(ctx.projectName, date);
    if (r) {
      return {
        workable: r.kind === "workable",
        effectiveScope: "project",
        reason: r.name || undefined,
      };
    }
  }

  // Global scope (manual rows first, then auto_holiday)
  const rg = db
    .query<KindRow, [string]>(
      `SELECT kind, name FROM calendar_exceptions
       WHERE project_name IS NULL AND planning_project_id IS NULL
         AND planning_team_id IS NULL AND user_id IS NULL
         AND date = ? AND deleted_at IS NULL
       ORDER BY source ASC LIMIT 1`,
    )
    .get(date);
  if (rg) {
    return {
      workable: rg.kind === "workable",
      effectiveScope: "global",
      reason: rg.name || undefined,
    };
  }

  // Default: weekend or weekday
  if (isWeekendDate(date)) {
    return { workable: false, effectiveScope: "weekend" };
  }
  return { workable: true, effectiveScope: "weekday_default" };
}

export function isWorkingDay(
  db: Database,
  date: string,
  ctx: CalendarResolveCtx,
): boolean {
  return resolveWorkingDay(db, date, ctx).workable;
}

// ── Phase 2 helper (pre-query for scheduler integration) ─────────────────────

/**
 * Pre-query all non-working dates in [fromDate, toDate] for the given context
 * and return as a Set<string> of ISO date strings. Used by the planning
 * scheduler (phase 2) so the pure-function `computeSchedule` stays DB-free.
 *
 * Weekends (Sat/Sun) are included in the set — the scheduler currently handles
 * these itself via `isWeekend()`, but including them here lets the phase 2
 * integration simply replace that check with a set lookup.
 *
 * The window must be wide enough to cover the planning horizon. Dates beyond
 * toDate that the scheduler reaches will fall back to the hardcoded weekend
 * rule — document this in the phase 2 PR.
 */
export function buildNonWorkingDateSet(
  db: Database,
  fromDate: string,
  toDate: string,
  ctx: CalendarResolveCtx,
): Set<string> {
  const result = new Set<string>();

  // Add all weekends in the range.
  const from = new Date(`${fromDate}T00:00:00Z`);
  const to = new Date(`${toDate}T00:00:00Z`);
  const cursor = new Date(from);
  while (cursor <= to) {
    const dow = cursor.getUTCDay();
    if (dow === 0 || dow === 6) {
      result.add(cursor.toISOString().slice(0, 10));
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  // Walk all relevant exceptions in the range and apply priority logic.
  // For efficiency we query each scope in bulk then resolve per-date in memory.
  type ExRow = { date: string; kind: string; scope: string; priority: number };

  const scopeClauses: string[] = [];
  const params: (string | number | null)[] = [fromDate, toDate];

  // Priority 5 (lowest) = global
  scopeClauses.push(`
    SELECT date, kind, 'global' AS scope, 5 AS priority
    FROM calendar_exceptions
    WHERE project_name IS NULL AND planning_project_id IS NULL
      AND planning_team_id IS NULL AND user_id IS NULL
      AND date BETWEEN ? AND ? AND deleted_at IS NULL`);

  if (ctx.projectName) {
    scopeClauses.push(`
      SELECT date, kind, 'project' AS scope, 4 AS priority
      FROM calendar_exceptions
      WHERE project_name = ? AND date BETWEEN ? AND ? AND deleted_at IS NULL`);
    params.push(ctx.projectName, fromDate, toDate);
  }

  if (ctx.planningProjectId) {
    scopeClauses.push(`
      SELECT date, kind, 'planning' AS scope, 3 AS priority
      FROM calendar_exceptions
      WHERE planning_project_id = ? AND planning_team_id IS NULL
        AND user_id IS NULL AND date BETWEEN ? AND ? AND deleted_at IS NULL`);
    params.push(ctx.planningProjectId, fromDate, toDate);
  }

  if (ctx.planningTeamId) {
    scopeClauses.push(`
      SELECT date, kind, 'team' AS scope, 2 AS priority
      FROM calendar_exceptions
      WHERE planning_team_id = ? AND user_id IS NULL
        AND date BETWEEN ? AND ? AND deleted_at IS NULL`);
    params.push(ctx.planningTeamId, fromDate, toDate);
  }

  if (ctx.userId) {
    scopeClauses.push(`
      SELECT date, kind, 'user' AS scope, 1 AS priority
      FROM calendar_exceptions
      WHERE user_id = ? AND date BETWEEN ? AND ? AND deleted_at IS NULL`);
    params.push(ctx.userId, fromDate, toDate);
  }

  // Combine all scopes, keep only the highest-priority (lowest priority number) per date.
  const sql = `
    SELECT date, kind, scope, priority FROM (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY date ORDER BY priority ASC) AS rn
      FROM (${scopeClauses.join(" UNION ALL ")})
    ) WHERE rn = 1`;

  const rows = db.query<ExRow, (string | number | null)[]>(sql).all(...params) as ExRow[];

  for (const row of rows) {
    if (row.kind === "non_working") {
      result.add(row.date);
    } else {
      // 'workable' explicitly un-blocks a date (e.g. a Saturday marked as workable).
      result.delete(row.date);
    }
  }

  return result;
}
