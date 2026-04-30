/**
 * Per-(user, project) memory.
 *
 * One row per (user, project) carries a compact, LLM-curated text body of
 * facts the system has learned about the user in that project's context.
 * The hourly `memory.refresh` handler advances `watermark_message_id` past
 * the messages it has already analysed and asks an LLM to merge new facts
 * in / compact when the body would exceed `MEMORY_FIELD_CHAR_LIMIT`.
 *
 * State machine: `'idle' → 'refreshing' → ('idle' | 'error')`. Stuck rows
 * (process death mid-call) are reclaimed by the same handler at the start
 * of every tick — `releaseStuckUserProjectMemory` flips rows whose
 * `refreshing_at` is older than the threshold back to `'idle'`.
 */

import type { Database } from "bun:sqlite";
import { MEMORY_FIELD_CHAR_LIMIT } from "./memory_constants.ts";

// Re-export so existing callers that import MEMORY_FIELD_CHAR_LIMIT from this
// module keep working without an import-site change.
export { MEMORY_FIELD_CHAR_LIMIT } from "./memory_constants.ts";

export type MemoryStatus = "idle" | "refreshing" | "error";

export interface UserProjectMemory {
  userId: string;
  project: string;
  memory: string;
  status: MemoryStatus;
  error: string | null;
  watermarkMessageId: number;
  manualEditedAt: number | null;
  refreshedAt: number | null;
  refreshingAt: number | null;
  createdAt: number;
  updatedAt: number;
}

interface UserProjectMemoryRow {
  user_id: string;
  project: string;
  memory: string;
  status: string;
  error: string | null;
  watermark_message_id: number;
  manual_edited_at: number | null;
  refreshed_at: number | null;
  refreshing_at: number | null;
  created_at: number;
  updated_at: number;
}

const SELECT_COLS = `user_id, project, memory, status, error,
                     watermark_message_id, manual_edited_at, refreshed_at,
                     refreshing_at, created_at, updated_at`;

function normaliseStatus(raw: string): MemoryStatus {
  return raw === "refreshing" || raw === "error" ? raw : "idle";
}

function rowTo(r: UserProjectMemoryRow): UserProjectMemory {
  return {
    userId: r.user_id,
    project: r.project,
    memory: r.memory,
    status: normaliseStatus(r.status),
    error: r.error,
    watermarkMessageId: r.watermark_message_id,
    manualEditedAt: r.manual_edited_at,
    refreshedAt: r.refreshed_at,
    refreshingAt: r.refreshing_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function getUserProjectMemory(
  db: Database,
  userId: string,
  project: string,
): UserProjectMemory | null {
  const row = db
    .prepare(
      `SELECT ${SELECT_COLS} FROM user_project_memory WHERE user_id = ? AND project = ?`,
    )
    .get(userId, project) as UserProjectMemoryRow | undefined;
  return row ? rowTo(row) : null;
}

/** Insert with defaults if missing; returns the existing or newly-created row. */
export function ensureUserProjectMemory(
  db: Database,
  userId: string,
  project: string,
): UserProjectMemory {
  const existing = getUserProjectMemory(db, userId, project);
  if (existing) return existing;
  const now = Date.now();
  db.prepare(
    `INSERT INTO user_project_memory(user_id, project, memory, status, watermark_message_id, created_at, updated_at)
     VALUES (?, ?, '', 'idle', 0, ?, ?)
     ON CONFLICT(user_id, project) DO NOTHING`,
  ).run(userId, project, now, now);
  return getUserProjectMemory(db, userId, project)!;
}

function clampMemory(text: string): string {
  if (text.length <= MEMORY_FIELD_CHAR_LIMIT) return text;
  return text.slice(0, MEMORY_FIELD_CHAR_LIMIT);
}

/**
 * Replace the memory body via the manual-edit affordance. Stamps
 * `manual_edited_at` so the next auto-refresh knows the user-supplied seed
 * is fresh. Throws when the input exceeds the field cap.
 */
export function setUserProjectMemoryManual(
  db: Database,
  userId: string,
  project: string,
  memory: string,
): UserProjectMemory {
  if (memory.length > MEMORY_FIELD_CHAR_LIMIT) {
    throw new Error(
      `memory exceeds ${MEMORY_FIELD_CHAR_LIMIT}-char cap (got ${memory.length})`,
    );
  }
  ensureUserProjectMemory(db, userId, project);
  const now = Date.now();
  db.prepare(
    `UPDATE user_project_memory
     SET memory = ?, manual_edited_at = ?, updated_at = ?
     WHERE user_id = ? AND project = ?`,
  ).run(memory, now, now, userId, project);
  return getUserProjectMemory(db, userId, project)!;
}

/**
 * Persist the LLM's merged result and advance the watermark. Truncates if the
 * model returned more than the budget — the call site should also have nudged
 * the model with the budget, but we never store > cap regardless.
 */
export function setUserProjectMemoryAuto(
  db: Database,
  userId: string,
  project: string,
  memory: string,
  watermarkMessageId: number,
): UserProjectMemory {
  const trimmed = clampMemory(memory);
  const now = Date.now();
  db.prepare(
    `UPDATE user_project_memory
     SET memory = ?, watermark_message_id = ?, status = 'idle', error = NULL,
         refreshing_at = NULL, refreshed_at = ?, updated_at = ?
     WHERE user_id = ? AND project = ?`,
  ).run(trimmed, watermarkMessageId, now, now, userId, project);
  return getUserProjectMemory(db, userId, project)!;
}

/**
 * Only advance the watermark — useful when the analyser found nothing
 * actionable in the new messages so the body stays as-is. Saves an LLM call
 * on a quiet next tick.
 */
export function bumpUserProjectMemoryWatermark(
  db: Database,
  userId: string,
  project: string,
  watermarkMessageId: number,
): void {
  const now = Date.now();
  db.prepare(
    `UPDATE user_project_memory
     SET watermark_message_id = ?, status = 'idle', error = NULL,
         refreshing_at = NULL, refreshed_at = ?, updated_at = ?
     WHERE user_id = ? AND project = ?`,
  ).run(watermarkMessageId, now, now, userId, project);
}

/**
 * Atomically claim the row for this tick by flipping `status` to
 * `'refreshing'`. Returns false when another tick already owns the row,
 * letting the caller move on without double-billing the LLM.
 */
export function claimUserProjectMemoryForRefresh(
  db: Database,
  userId: string,
  project: string,
  now: number = Date.now(),
): boolean {
  ensureUserProjectMemory(db, userId, project);
  const info = db
    .prepare(
      `UPDATE user_project_memory
       SET status = 'refreshing', refreshing_at = ?, error = NULL, updated_at = ?
       WHERE user_id = ? AND project = ? AND status != 'refreshing'`,
    )
    .run(now, now, userId, project);
  return info.changes > 0;
}

export function setUserProjectMemoryError(
  db: Database,
  userId: string,
  project: string,
  error: string,
): void {
  const now = Date.now();
  db.prepare(
    `UPDATE user_project_memory
     SET status = 'error', error = ?, refreshing_at = NULL, updated_at = ?
     WHERE user_id = ? AND project = ?`,
  ).run(error, now, userId, project);
}

/**
 * Reclaim rows stuck in `'refreshing'` for longer than `thresholdMs`. Returns
 * the (user_id, project) pairs that were reset so the caller can log them.
 */
export function releaseStuckUserProjectMemory(
  db: Database,
  thresholdMs: number,
  now: number = Date.now(),
): Array<{ userId: string; project: string }> {
  const cutoff = now - thresholdMs;
  return (
    db
      .prepare(
        `UPDATE user_project_memory
         SET status = 'idle', error = NULL, refreshing_at = NULL, updated_at = ?
         WHERE status = 'refreshing' AND refreshing_at IS NOT NULL AND refreshing_at < ?
         RETURNING user_id, project`,
      )
      .all(now, cutoff) as Array<{ user_id: string; project: string }>
  ).map((r) => ({ userId: r.user_id, project: r.project }));
}

/**
 * Return rows that look like they have new messages to digest. The handler
 * still re-checks per row before calling the LLM (rows the user is actively
 * refreshing get skipped), so this query is intentionally cheap.
 */
export function listUserProjectMemoryRefreshCandidates(
  db: Database,
  limit: number,
): UserProjectMemory[] {
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLS} FROM user_project_memory
       WHERE status = 'idle'
       ORDER BY COALESCE(refreshed_at, 0) ASC
       LIMIT ?`,
    )
    .all(limit) as UserProjectMemoryRow[];
  return rows.map(rowTo);
}
