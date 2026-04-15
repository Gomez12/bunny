/**
 * Scheduled tasks — CRUD + claim semantics over `scheduled_tasks`.
 *
 * The ticker in `src/scheduler/ticker.ts` calls `claimDueTasks(db, now)` to
 * select enabled rows whose `next_run_at` has passed. The claim is atomic: it
 * bumps `next_run_at` to `now + 1 minute` inside the same transaction so a
 * parallel tick can never pick up the same row. After the handler runs, the
 * scheduler calls `setTaskResult(...)` with the real next-fire timestamp.
 *
 * Rows are typed as `system` or `user`. The code here is domain-agnostic;
 * handler-specific logic lives with the handler registration.
 */

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

export type TaskKind = "system" | "user";
export type TaskStatus = "ok" | "error";

export interface ScheduledTask {
  id: string;
  kind: TaskKind;
  handler: string;
  name: string;
  description: string | null;
  cronExpr: string;
  payload: unknown;
  enabled: boolean;
  ownerUserId: string | null;
  lastRunAt: number | null;
  lastStatus: TaskStatus | null;
  lastError: string | null;
  nextRunAt: number;
  createdAt: number;
  updatedAt: number;
}

interface TaskRow {
  id: string;
  kind: string;
  handler: string;
  name: string;
  description: string | null;
  cron_expr: string;
  payload: string | null;
  enabled: number;
  owner_user_id: string | null;
  last_run_at: number | null;
  last_status: string | null;
  last_error: string | null;
  next_run_at: number;
  created_at: number;
  updated_at: number;
}

const SELECT_COLS = `id, kind, handler, name, description, cron_expr, payload,
                     enabled, owner_user_id, last_run_at, last_status, last_error,
                     next_run_at, created_at, updated_at`;

function rowToTask(r: TaskRow): ScheduledTask {
  let payload: unknown = null;
  if (r.payload) {
    try {
      payload = JSON.parse(r.payload);
    } catch {
      payload = null;
    }
  }
  return {
    id: r.id,
    kind: r.kind as TaskKind,
    handler: r.handler,
    name: r.name,
    description: r.description,
    cronExpr: r.cron_expr,
    payload,
    enabled: r.enabled !== 0,
    ownerUserId: r.owner_user_id,
    lastRunAt: r.last_run_at,
    lastStatus: (r.last_status as TaskStatus | null) ?? null,
    lastError: r.last_error,
    nextRunAt: r.next_run_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface CreateTaskOpts {
  id?: string;
  kind: TaskKind;
  handler: string;
  name: string;
  description?: string | null;
  cronExpr: string;
  payload?: unknown;
  enabled?: boolean;
  ownerUserId?: string | null;
  nextRunAt: number;
}

export function createTask(db: Database, opts: CreateTaskOpts): ScheduledTask {
  const id = opts.id ?? randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO scheduled_tasks(id, kind, handler, name, description, cron_expr,
                                 payload, enabled, owner_user_id,
                                 next_run_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.kind,
    opts.handler,
    opts.name.trim(),
    opts.description ?? null,
    opts.cronExpr.trim(),
    opts.payload === undefined ? null : JSON.stringify(opts.payload),
    opts.enabled === false ? 0 : 1,
    opts.ownerUserId ?? null,
    opts.nextRunAt,
    now,
    now,
  );
  return getTask(db, id)!;
}

export function getTask(db: Database, id: string): ScheduledTask | null {
  const row = db
    .prepare(`SELECT ${SELECT_COLS} FROM scheduled_tasks WHERE id = ?`)
    .get(id) as TaskRow | undefined;
  return row ? rowToTask(row) : null;
}

export interface ListTasksOpts {
  kind?: TaskKind;
  ownerUserId?: string;
}

export function listTasks(db: Database, opts: ListTasksOpts = {}): ScheduledTask[] {
  const where: string[] = [];
  const params: (string | number | null)[] = [];
  if (opts.kind) {
    where.push("kind = ?");
    params.push(opts.kind);
  }
  if (opts.ownerUserId !== undefined) {
    where.push("owner_user_id = ?");
    params.push(opts.ownerUserId);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const stmt = db.prepare(
    `SELECT ${SELECT_COLS} FROM scheduled_tasks ${whereSql}
     ORDER BY kind ASC, name ASC`,
  );
  const rows = (params.length === 0 ? stmt.all() : stmt.all(...params)) as TaskRow[];
  return rows.map(rowToTask);
}

export interface UpdateTaskPatch {
  name?: string;
  description?: string | null;
  cronExpr?: string;
  payload?: unknown;
  enabled?: boolean;
  nextRunAt?: number;
}

export function updateTask(db: Database, id: string, patch: UpdateTaskPatch): ScheduledTask {
  const existing = getTask(db, id);
  if (!existing) throw new Error(`scheduled task ${id} not found`);
  const name = patch.name === undefined ? existing.name : patch.name.trim();
  if (!name) throw new Error("task name is required");
  const description =
    patch.description === undefined ? existing.description : patch.description;
  const cronExpr = patch.cronExpr === undefined ? existing.cronExpr : patch.cronExpr.trim();
  const payload =
    patch.payload === undefined
      ? (existing.payload === null ? null : JSON.stringify(existing.payload))
      : patch.payload === null
        ? null
        : JSON.stringify(patch.payload);
  const enabled = patch.enabled === undefined ? existing.enabled : patch.enabled;
  const nextRunAt = patch.nextRunAt === undefined ? existing.nextRunAt : patch.nextRunAt;
  db.prepare(
    `UPDATE scheduled_tasks
       SET name = ?, description = ?, cron_expr = ?, payload = ?,
           enabled = ?, next_run_at = ?, updated_at = ?
     WHERE id = ?`,
  ).run(name, description, cronExpr, payload, enabled ? 1 : 0, nextRunAt, Date.now(), id);
  return getTask(db, id)!;
}

export function deleteTask(db: Database, id: string): void {
  db.prepare(`DELETE FROM scheduled_tasks WHERE id = ?`).run(id);
}

/**
 * Atomically select and "claim" due tasks. The claim bumps `next_run_at` by
 * one minute so a concurrent tick will not re-pick the same row while the
 * handler is still running. The scheduler must subsequently call
 * `setTaskResult(...)` with the correct cron-derived next timestamp.
 *
 * Returned rows are a snapshot of the pre-bump state so handlers see the
 * original cron metadata they need.
 */
export function claimDueTasks(db: Database, now: number): ScheduledTask[] {
  const tx = db.transaction(() => {
    const rows = db
      .prepare(
        `SELECT ${SELECT_COLS} FROM scheduled_tasks
           WHERE enabled = 1 AND next_run_at <= ?
           ORDER BY next_run_at ASC`,
      )
      .all(now) as TaskRow[];
    if (rows.length === 0) return [] as ScheduledTask[];
    const bumped = now + 60_000;
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");
    db.prepare(
      `UPDATE scheduled_tasks SET next_run_at = ?, updated_at = ?
         WHERE id IN (${placeholders})`,
    ).run(bumped, now, ...ids);
    return rows.map(rowToTask);
  });
  return tx();
}

export interface SetTaskResultOpts {
  status: TaskStatus;
  error?: string | null;
  nextRunAt: number;
  ranAt?: number;
}

export function setTaskResult(db: Database, id: string, opts: SetTaskResultOpts): void {
  db.prepare(
    `UPDATE scheduled_tasks
       SET last_run_at = ?, last_status = ?, last_error = ?,
           next_run_at = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    opts.ranAt ?? Date.now(),
    opts.status,
    opts.error ?? null,
    opts.nextRunAt,
    Date.now(),
    id,
  );
}

/** Idempotent seed — used for system-tasks installed at boot. */
export function ensureSystemTask(
  db: Database,
  handler: string,
  defaults: {
    name: string;
    description?: string;
    cronExpr: string;
    payload?: unknown;
    nextRunAt: number;
  },
): ScheduledTask {
  const existing = db
    .prepare(
      `SELECT ${SELECT_COLS} FROM scheduled_tasks WHERE kind = 'system' AND handler = ? LIMIT 1`,
    )
    .get(handler) as TaskRow | undefined;
  if (existing) return rowToTask(existing);
  return createTask(db, {
    kind: "system",
    handler,
    name: defaults.name,
    description: defaults.description ?? null,
    cronExpr: defaults.cronExpr,
    payload: defaults.payload,
    nextRunAt: defaults.nextRunAt,
  });
}
