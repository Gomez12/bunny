/**
 * Per-(agent, project) memory.
 *
 * Mirrors `user_project_memory` but keyed on (agent_name, project_name). The
 * row stores facts that the agent has accumulated about this project — its
 * users, recurring constraints, observed style — so future replies can lean
 * on context the agent has already established. See ADR 0034.
 */

import type { Database } from "bun:sqlite";
import { MEMORY_FIELD_CHAR_LIMIT } from "./memory_constants.ts";
import type { MemoryStatus } from "./user_project_memory.ts";

export interface AgentProjectMemory {
  agent: string;
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

interface AgentProjectMemoryRow {
  agent: string;
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

const SELECT_COLS = `agent, project, memory, status, error,
                     watermark_message_id, manual_edited_at, refreshed_at,
                     refreshing_at, created_at, updated_at`;

function normaliseStatus(raw: string): MemoryStatus {
  return raw === "refreshing" || raw === "error" ? raw : "idle";
}

function rowTo(r: AgentProjectMemoryRow): AgentProjectMemory {
  return {
    agent: r.agent,
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

export function getAgentProjectMemory(
  db: Database,
  agent: string,
  project: string,
): AgentProjectMemory | null {
  const row = db
    .prepare(
      `SELECT ${SELECT_COLS} FROM agent_project_memory WHERE agent = ? AND project = ?`,
    )
    .get(agent, project) as AgentProjectMemoryRow | undefined;
  return row ? rowTo(row) : null;
}

export function ensureAgentProjectMemory(
  db: Database,
  agent: string,
  project: string,
): AgentProjectMemory {
  const existing = getAgentProjectMemory(db, agent, project);
  if (existing) return existing;
  const now = Date.now();
  db.prepare(
    `INSERT INTO agent_project_memory(agent, project, memory, status, watermark_message_id, created_at, updated_at)
     VALUES (?, ?, '', 'idle', 0, ?, ?)
     ON CONFLICT(agent, project) DO NOTHING`,
  ).run(agent, project, now, now);
  return getAgentProjectMemory(db, agent, project)!;
}

function clampMemory(text: string): string {
  if (text.length <= MEMORY_FIELD_CHAR_LIMIT) return text;
  return text.slice(0, MEMORY_FIELD_CHAR_LIMIT);
}

export function setAgentProjectMemoryManual(
  db: Database,
  agent: string,
  project: string,
  memory: string,
): AgentProjectMemory {
  if (memory.length > MEMORY_FIELD_CHAR_LIMIT) {
    throw new Error(
      `memory exceeds ${MEMORY_FIELD_CHAR_LIMIT}-char cap (got ${memory.length})`,
    );
  }
  ensureAgentProjectMemory(db, agent, project);
  const now = Date.now();
  db.prepare(
    `UPDATE agent_project_memory
     SET memory = ?, manual_edited_at = ?, updated_at = ?
     WHERE agent = ? AND project = ?`,
  ).run(memory, now, now, agent, project);
  return getAgentProjectMemory(db, agent, project)!;
}

export function setAgentProjectMemoryAuto(
  db: Database,
  agent: string,
  project: string,
  memory: string,
  watermarkMessageId: number,
): AgentProjectMemory {
  const trimmed = clampMemory(memory);
  const now = Date.now();
  db.prepare(
    `UPDATE agent_project_memory
     SET memory = ?, watermark_message_id = ?, status = 'idle', error = NULL,
         refreshing_at = NULL, refreshed_at = ?, updated_at = ?
     WHERE agent = ? AND project = ?`,
  ).run(trimmed, watermarkMessageId, now, now, agent, project);
  return getAgentProjectMemory(db, agent, project)!;
}

export function bumpAgentProjectMemoryWatermark(
  db: Database,
  agent: string,
  project: string,
  watermarkMessageId: number,
): void {
  const now = Date.now();
  db.prepare(
    `UPDATE agent_project_memory
     SET watermark_message_id = ?, status = 'idle', error = NULL,
         refreshing_at = NULL, refreshed_at = ?, updated_at = ?
     WHERE agent = ? AND project = ?`,
  ).run(watermarkMessageId, now, now, agent, project);
}

export function claimAgentProjectMemoryForRefresh(
  db: Database,
  agent: string,
  project: string,
  now: number = Date.now(),
): boolean {
  ensureAgentProjectMemory(db, agent, project);
  const info = db
    .prepare(
      `UPDATE agent_project_memory
       SET status = 'refreshing', refreshing_at = ?, error = NULL, updated_at = ?
       WHERE agent = ? AND project = ? AND status != 'refreshing'`,
    )
    .run(now, now, agent, project);
  return info.changes > 0;
}

export function setAgentProjectMemoryError(
  db: Database,
  agent: string,
  project: string,
  error: string,
): void {
  const now = Date.now();
  db.prepare(
    `UPDATE agent_project_memory
     SET status = 'error', error = ?, refreshing_at = NULL, updated_at = ?
     WHERE agent = ? AND project = ?`,
  ).run(error, now, agent, project);
}

export function releaseStuckAgentProjectMemory(
  db: Database,
  thresholdMs: number,
  now: number = Date.now(),
): Array<{ agent: string; project: string }> {
  const cutoff = now - thresholdMs;
  return (
    db
      .prepare(
        `UPDATE agent_project_memory
         SET status = 'idle', error = NULL, refreshing_at = NULL, updated_at = ?
         WHERE status = 'refreshing' AND refreshing_at IS NOT NULL AND refreshing_at < ?
         RETURNING agent, project`,
      )
      .all(now, cutoff) as Array<{ agent: string; project: string }>
  ).map((r) => ({ agent: r.agent, project: r.project }));
}

export function listAgentProjectMemoryRefreshCandidates(
  db: Database,
  limit: number,
): AgentProjectMemory[] {
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLS} FROM agent_project_memory
       WHERE status = 'idle'
       ORDER BY COALESCE(refreshed_at, 0) ASC
       LIMIT ?`,
    )
    .all(limit) as AgentProjectMemoryRow[];
  return rows.map(rowTo);
}
