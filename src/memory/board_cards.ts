/**
 * Board cards — CRUD over `board_cards`.
 *
 * A card is one task pinned to a swimlane. Each card has a sparse `position`
 * (steps of {@link POSITION_STEP}) within its lane so drag-and-drop only
 * rewrites the moved card; reorders never cascade.
 *
 * Assignee is mutually exclusive: at most one of `assigneeUserId` /
 * `assigneeAgent` is non-null. Agent-assigned cards can be executed via
 * `src/board/run_card.ts` (built in PR 6).
 */

import type { Database } from "bun:sqlite";
import { POSITION_STEP } from "./board_swimlanes.ts";
import { prep } from "./prepared.ts";
import type { Project } from "./projects.ts";
import type { User } from "../auth/users.ts";

export interface Card {
  id: number;
  project: string;
  swimlaneId: number;
  position: number;
  title: string;
  description: string;
  assigneeUserId: string | null;
  assigneeAgent: string | null;
  autoRun: boolean;
  estimateHours: number | null;
  percentDone: number | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

interface CardRow {
  id: number;
  project: string;
  swimlane_id: number;
  position: number;
  title: string;
  description: string;
  assignee_user_id: string | null;
  assignee_agent: string | null;
  auto_run: number;
  estimate_hours: number | null;
  percent_done: number | null;
  created_by: string;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

function rowToCard(r: CardRow): Card {
  return {
    id: r.id,
    project: r.project,
    swimlaneId: r.swimlane_id,
    position: r.position,
    title: r.title,
    description: r.description,
    assigneeUserId: r.assignee_user_id,
    assigneeAgent: r.assignee_agent,
    autoRun: (r.auto_run ?? 0) !== 0,
    estimateHours: r.estimate_hours ?? null,
    percentDone: r.percent_done ?? null,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    archivedAt: r.archived_at,
  };
}

const SELECT_COLS = `id, project, swimlane_id, position, title, description,
                     assignee_user_id, assignee_agent, auto_run, estimate_hours, percent_done,
                     created_by, created_at, updated_at, archived_at`;

export interface ListCardsOpts {
  includeArchived?: boolean;
}

export function listCards(
  db: Database,
  project: string,
  opts: ListCardsOpts = {},
): Card[] {
  const where = opts.includeArchived ? "" : "AND archived_at IS NULL";
  const rows = prep(
    db,
    `SELECT ${SELECT_COLS} FROM board_cards
       WHERE project = ? ${where}
       ORDER BY swimlane_id ASC, position ASC, id ASC`,
  ).all(project) as CardRow[];
  return rows.map(rowToCard);
}

export function getCard(db: Database, id: number): Card | null {
  const row = prep(
    db,
    `SELECT ${SELECT_COLS} FROM board_cards WHERE id = ?`,
  ).get(id) as CardRow | undefined;
  return row ? rowToCard(row) : null;
}

export interface CreateCardOpts {
  project: string;
  swimlaneId: number;
  title: string;
  description?: string;
  assigneeUserId?: string | null;
  assigneeAgent?: string | null;
  /** When omitted, defaults to `true` iff an agent is the assignee. */
  autoRun?: boolean;
  estimateHours?: number | null;
  percentDone?: number | null;
  createdBy: string;
  position?: number;
}

export function createCard(db: Database, opts: CreateCardOpts): Card {
  validateAssignee(opts.assigneeUserId ?? null, opts.assigneeAgent ?? null);
  const title = opts.title.trim();
  if (!title) throw new Error("card title is required");
  const now = Date.now();
  const position = opts.position ?? nextPosition(db, opts.swimlaneId);
  const autoRun = opts.autoRun ?? Boolean(opts.assigneeAgent);
  const info = prep(
    db,
    `INSERT INTO board_cards(project, swimlane_id, position, title, description,
                               assignee_user_id, assignee_agent, auto_run,
                               estimate_hours, percent_done, created_by,
                               created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.project,
    opts.swimlaneId,
    position,
    title,
    opts.description ?? "",
    opts.assigneeUserId ?? null,
    opts.assigneeAgent ?? null,
    autoRun ? 1 : 0,
    opts.estimateHours ?? null,
    opts.percentDone ?? null,
    opts.createdBy,
    now,
    now,
  );
  return getCard(db, Number(info.lastInsertRowid))!;
}

export interface UpdateCardPatch {
  title?: string;
  description?: string;
  assigneeUserId?: string | null;
  assigneeAgent?: string | null;
  autoRun?: boolean;
  estimateHours?: number | null;
  percentDone?: number | null;
  swimlaneId?: number;
  position?: number;
}

export function updateCard(
  db: Database,
  id: number,
  patch: UpdateCardPatch,
): Card {
  const existing = getCard(db, id);
  if (!existing) throw new Error(`card ${id} not found`);
  const assigneeUser =
    patch.assigneeUserId === undefined
      ? existing.assigneeUserId
      : patch.assigneeUserId;
  const assigneeAgent =
    patch.assigneeAgent === undefined
      ? existing.assigneeAgent
      : patch.assigneeAgent;
  validateAssignee(assigneeUser, assigneeAgent);
  const title = patch.title === undefined ? existing.title : patch.title.trim();
  if (!title) throw new Error("card title is required");
  const description = patch.description ?? existing.description;
  const swimlaneId = patch.swimlaneId ?? existing.swimlaneId;
  const position = patch.position ?? existing.position;
  // Auto-run defaulting: when the caller newly assigns an agent without
  // specifying `autoRun`, flip it on so the scheduled scan can pick it up.
  let autoRun: boolean;
  if (patch.autoRun !== undefined) {
    autoRun = patch.autoRun;
  } else if (
    patch.assigneeAgent !== undefined &&
    patch.assigneeAgent &&
    patch.assigneeAgent !== existing.assigneeAgent
  ) {
    autoRun = true;
  } else {
    autoRun = existing.autoRun;
  }
  const estimateHours =
    patch.estimateHours === undefined
      ? existing.estimateHours
      : patch.estimateHours;
  const percentDone =
    patch.percentDone === undefined ? existing.percentDone : patch.percentDone;
  prep(
    db,
    `UPDATE board_cards
     SET title = ?, description = ?, assignee_user_id = ?, assignee_agent = ?,
         auto_run = ?, estimate_hours = ?, percent_done = ?,
         swimlane_id = ?, position = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    title,
    description,
    assigneeUser,
    assigneeAgent,
    autoRun ? 1 : 0,
    estimateHours,
    percentDone,
    swimlaneId,
    position,
    Date.now(),
    id,
  );
  return getCard(db, id)!;
}

/**
 * Atomically clear the `auto_run` flag on a card. Returns `true` iff the row
 * was still marked — used by the scheduler to reserve a card for exactly one
 * enqueue even if two ticks race.
 */
export function clearAutoRun(db: Database, id: number): boolean {
  const info = prep(
    db,
    `UPDATE board_cards SET auto_run = 0, updated_at = ? WHERE id = ? AND auto_run = 1`,
  ).run(Date.now(), id);
  return info.changes > 0;
}

export interface MoveCardOpts {
  swimlaneId: number;
  /** Place before this card (id must be in target lane). */
  beforeCardId?: number;
  /** Place after this card (id must be in target lane). */
  afterCardId?: number;
  /** Or set position explicitly. */
  position?: number;
}

/**
 * Move a card to another lane and/or position. Picks a midpoint between the
 * existing neighbours so reorders never touch sibling rows. When the resulting
 * gap collapses (e.g. neighbours one apart), we shift to old+POSITION_STEP and
 * accept that future moves may need a periodic re-spread (rare in practice).
 */
export function moveCard(db: Database, id: number, opts: MoveCardOpts): Card {
  const existing = getCard(db, id);
  if (!existing) throw new Error(`card ${id} not found`);

  const swimlaneId = opts.swimlaneId;
  let position: number;
  if (opts.position !== undefined) {
    position = opts.position;
  } else {
    position = computeMidpointPosition(
      db,
      swimlaneId,
      id,
      opts.beforeCardId,
      opts.afterCardId,
    );
  }

  prep(
    db,
    `UPDATE board_cards
     SET swimlane_id = ?, position = ?, updated_at = ?
     WHERE id = ?`,
  ).run(swimlaneId, position, Date.now(), id);
  return getCard(db, id)!;
}

export function archiveCard(db: Database, id: number): void {
  prep(
    db,
    `UPDATE board_cards SET archived_at = ?, updated_at = ? WHERE id = ?`,
  ).run(Date.now(), Date.now(), id);
}

/**
 * Permission check for editing/moving/archiving a card. Admin and project
 * owner always pass; otherwise the user must be the card creator or the
 * assignee. Run-permission uses the same gate.
 */
export function canEditCard(user: User, card: Card, project: Project): boolean {
  if (user.role === "admin") return true;
  if (project.createdBy && project.createdBy === user.id) return true;
  if (card.createdBy === user.id) return true;
  if (card.assigneeUserId && card.assigneeUserId === user.id) return true;
  return false;
}

// ── helpers ───────────────────────────────────────────────────────────────

function validateAssignee(userId: string | null, agent: string | null): void {
  if (userId && agent) {
    throw new Error(
      "card assignee must be either a user or an agent, not both",
    );
  }
}

function nextPosition(db: Database, swimlaneId: number): number {
  const row = prep(
    db,
    `SELECT MAX(position) AS maxp FROM board_cards WHERE swimlane_id = ?`,
  ).get(swimlaneId) as { maxp: number | null } | undefined;
  return (row?.maxp ?? 0) + POSITION_STEP;
}

function computeMidpointPosition(
  db: Database,
  swimlaneId: number,
  movingId: number,
  beforeCardId?: number,
  afterCardId?: number,
): number {
  let before =
    beforeCardId !== undefined ? getNeighbourPosition(db, beforeCardId) : null;
  let after =
    afterCardId !== undefined ? getNeighbourPosition(db, afterCardId) : null;

  // Place at top of lane (before the named card).
  if (before !== null && after === null) {
    return Math.max(1, before - POSITION_STEP);
  }
  // Place at bottom of lane (after the named card).
  if (after !== null && before === null) {
    return after + POSITION_STEP;
  }
  // Place between two neighbours.
  if (before !== null && after !== null) {
    if (before > after) [before, after] = [after, before];
    const mid = Math.floor((before + after) / 2);
    return mid === before ? before + 1 : mid;
  }
  // No neighbours given → append to end of target lane (skip moving card).
  const row = prep(
    db,
    `SELECT MAX(position) AS maxp FROM board_cards
       WHERE swimlane_id = ? AND id != ?`,
  ).get(swimlaneId, movingId) as { maxp: number | null } | undefined;
  return (row?.maxp ?? 0) + POSITION_STEP;
}

function getNeighbourPosition(db: Database, cardId: number): number {
  const row = prep(db, `SELECT position FROM board_cards WHERE id = ?`).get(
    cardId,
  ) as { position: number } | undefined;
  if (!row) throw new Error(`neighbour card ${cardId} not found`);
  return row.position;
}
