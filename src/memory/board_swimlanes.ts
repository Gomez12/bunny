/**
 * Swimlane (kanban column) registry — CRUD over `board_swimlanes`.
 *
 * One board per project; each lane is identified by its row id. Position is a
 * sparse integer (steps of {@link POSITION_STEP}) so reordering only touches
 * one row at a time. Default lanes Todo/Doing/Done are seeded by
 * {@link seedDefaultSwimlanes}, called from `createProject`.
 */

import type { Database } from "bun:sqlite";

export const POSITION_STEP = 100;
export const DEFAULT_SWIMLANES = ["Todo", "Doing", "Done"] as const;

export interface Swimlane {
  id: number;
  project: string;
  name: string;
  position: number;
  wipLimit: number | null;
  autoRun: boolean;
  createdAt: number;
  updatedAt: number;
}

interface SwimlaneRow {
  id: number;
  project: string;
  name: string;
  position: number;
  wip_limit: number | null;
  auto_run: number;
  created_at: number;
  updated_at: number;
}

function rowToSwimlane(r: SwimlaneRow): Swimlane {
  return {
    id: r.id,
    project: r.project,
    name: r.name,
    position: r.position,
    wipLimit: r.wip_limit,
    autoRun: (r.auto_run ?? 0) !== 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const SELECT_COLS = `id, project, name, position, wip_limit, auto_run, created_at, updated_at`;

export function listSwimlanes(db: Database, project: string): Swimlane[] {
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLS} FROM board_swimlanes
       WHERE project = ? ORDER BY position ASC, id ASC`,
    )
    .all(project) as SwimlaneRow[];
  return rows.map(rowToSwimlane);
}

export function getSwimlane(db: Database, id: number): Swimlane | null {
  const row = db
    .prepare(`SELECT ${SELECT_COLS} FROM board_swimlanes WHERE id = ?`)
    .get(id) as SwimlaneRow | undefined;
  return row ? rowToSwimlane(row) : null;
}

export interface CreateSwimlaneOpts {
  project: string;
  name: string;
  position?: number;
  wipLimit?: number | null;
  autoRun?: boolean;
}

export function createSwimlane(db: Database, opts: CreateSwimlaneOpts): Swimlane {
  const now = Date.now();
  const position = opts.position ?? nextPosition(db, opts.project);
  const info = db
    .prepare(
      `INSERT INTO board_swimlanes(project, name, position, wip_limit, auto_run, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.project,
      opts.name,
      position,
      opts.wipLimit ?? null,
      opts.autoRun ? 1 : 0,
      now,
      now,
    );
  return getSwimlane(db, Number(info.lastInsertRowid))!;
}

export interface UpdateSwimlanePatch {
  name?: string;
  position?: number;
  wipLimit?: number | null;
  autoRun?: boolean;
}

export function updateSwimlane(db: Database, id: number, patch: UpdateSwimlanePatch): Swimlane {
  const existing = getSwimlane(db, id);
  if (!existing) throw new Error(`swimlane ${id} not found`);
  const name = patch.name ?? existing.name;
  const position = patch.position ?? existing.position;
  const wipLimit = patch.wipLimit === undefined ? existing.wipLimit : patch.wipLimit;
  const autoRun = patch.autoRun === undefined ? existing.autoRun : patch.autoRun;
  db.prepare(
    `UPDATE board_swimlanes
     SET name = ?, position = ?, wip_limit = ?, auto_run = ?, updated_at = ?
     WHERE id = ?`,
  ).run(name, position, wipLimit, autoRun ? 1 : 0, Date.now(), id);
  return getSwimlane(db, id)!;
}

/**
 * Delete a swimlane. Refuses if any non-archived cards still live in it — the
 * caller must move them first to avoid orphaning work.
 */
export function deleteSwimlane(db: Database, id: number): void {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM board_cards
       WHERE swimlane_id = ? AND archived_at IS NULL`,
    )
    .get(id) as { n: number } | undefined;
  if (row && row.n > 0) {
    throw new Error(`swimlane ${id} still has ${row.n} active cards`);
  }
  db.prepare(`DELETE FROM board_swimlanes WHERE id = ?`).run(id);
}

/** Next position = max(position) + POSITION_STEP, or POSITION_STEP if empty. */
function nextPosition(db: Database, project: string): number {
  const row = db
    .prepare(`SELECT MAX(position) AS maxp FROM board_swimlanes WHERE project = ?`)
    .get(project) as { maxp: number | null } | undefined;
  const max = row?.maxp ?? null;
  return (max ?? 0) + POSITION_STEP;
}

/**
 * Seed Todo/Doing/Done for a project iff the project currently has zero lanes.
 * Idempotent — safe to call from `createProject` and from on-demand backfill
 * paths (e.g. board GET on a legacy project).
 */
export function seedDefaultSwimlanes(db: Database, project: string): void {
  const existing = listSwimlanes(db, project);
  if (existing.length > 0) return;
  let position = POSITION_STEP;
  for (const name of DEFAULT_SWIMLANES) {
    createSwimlane(db, { project, name, position });
    position += POSITION_STEP;
  }
}
