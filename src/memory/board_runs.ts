/**
 * Card run history — CRUD over `board_card_runs`.
 *
 * Each row records one execution of a card by an agent: which session was
 * spawned, who triggered it, and how it ended. Mirrors the final assistant
 * answer onto the row so the board UI can show a preview without re-querying
 * the messages table.
 */

import type { Database } from "bun:sqlite";

export type RunStatus = "queued" | "running" | "done" | "error";
export type RunTriggerKind = "manual" | "scheduled";

export interface CardRun {
  id: number;
  cardId: number;
  sessionId: string;
  agent: string;
  triggeredBy: string;
  triggerKind: RunTriggerKind;
  status: RunStatus;
  startedAt: number;
  finishedAt: number | null;
  finalAnswer: string | null;
  error: string | null;
}

interface RunRow {
  id: number;
  card_id: number;
  session_id: string;
  agent: string;
  triggered_by: string;
  trigger_kind: string;
  status: string;
  started_at: number;
  finished_at: number | null;
  final_answer: string | null;
  error: string | null;
}

function rowToRun(r: RunRow): CardRun {
  return {
    id: r.id,
    cardId: r.card_id,
    sessionId: r.session_id,
    agent: r.agent,
    triggeredBy: r.triggered_by,
    triggerKind: (r.trigger_kind as RunTriggerKind) ?? "manual",
    status: (r.status as RunStatus) ?? "queued",
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    finalAnswer: r.final_answer,
    error: r.error,
  };
}

const SELECT_COLS = `id, card_id, session_id, agent, triggered_by, trigger_kind,
                     status, started_at, finished_at, final_answer, error`;

export function getRun(db: Database, id: number): CardRun | null {
  const row = db
    .prepare(`SELECT ${SELECT_COLS} FROM board_card_runs WHERE id = ?`)
    .get(id) as RunRow | undefined;
  return row ? rowToRun(row) : null;
}

export function listRunsForCard(db: Database, cardId: number): CardRun[] {
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLS} FROM board_card_runs
       WHERE card_id = ? ORDER BY started_at DESC, id DESC`,
    )
    .all(cardId) as RunRow[];
  return rows.map(rowToRun);
}

export interface CreateRunOpts {
  cardId: number;
  sessionId: string;
  agent: string;
  triggeredBy: string;
  triggerKind?: RunTriggerKind;
  status?: RunStatus;
}

export function createRun(db: Database, opts: CreateRunOpts): CardRun {
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO board_card_runs(card_id, session_id, agent, triggered_by,
                                   trigger_kind, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.cardId,
      opts.sessionId,
      opts.agent,
      opts.triggeredBy,
      opts.triggerKind ?? "manual",
      opts.status ?? "running",
      now,
    );
  return getRun(db, Number(info.lastInsertRowid))!;
}

export function markRunRunning(db: Database, id: number): void {
  db.prepare(`UPDATE board_card_runs SET status = 'running' WHERE id = ?`).run(id);
}

export interface MarkRunDoneOpts {
  finalAnswer?: string | null;
}

export function markRunDone(db: Database, id: number, opts: MarkRunDoneOpts = {}): void {
  db.prepare(
    `UPDATE board_card_runs SET status = 'done', finished_at = ?, final_answer = ? WHERE id = ?`,
  ).run(Date.now(), opts.finalAnswer ?? null, id);
}

export function markRunError(db: Database, id: number, error: string): void {
  db.prepare(
    `UPDATE board_card_runs SET status = 'error', finished_at = ?, error = ? WHERE id = ?`,
  ).run(Date.now(), error, id);
}
