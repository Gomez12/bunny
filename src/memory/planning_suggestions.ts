/**
 * Planning suggestions — at most one *pending* suggestion per planning
 * project. The scheduler-tick handler and the user's "Generate advice"
 * button both call `replacePending`, which atomically deletes the previous
 * pending row (if any) and inserts a new one. Accepting/rejecting flips
 * the status and stamps decision_by_user_id.
 */

import type { Database } from "bun:sqlite";

export type SuggestionStatus = "pending" | "accepted" | "rejected";

export interface SuggestionPlacement {
  wishId: number;
  start: string;
  end: string;
}

export type BottleneckKind =
  | "deadline_overrun"
  | "cycle"
  | "tag_unmet"
  | "missing_team";

export interface SuggestionBottleneck {
  wishId: number;
  kind: BottleneckKind;
  message: string;
}

export interface SuggestionPayload {
  placements: SuggestionPlacement[];
  bottlenecks: SuggestionBottleneck[];
}

export interface PlanningSuggestion {
  id: number;
  planningProjectId: number;
  generatedAt: number;
  status: SuggestionStatus;
  payload: SuggestionPayload;
  generatedByUserId: string | null;
  decidedByUserId: string | null;
  decidedAt: number | null;
  decisionComment: string;
}

interface SuggestionRow {
  id: number;
  planning_project_id: number;
  generated_at: number;
  status: string;
  payload_json: string;
  generated_by_user_id: string | null;
  decided_by_user_id: string | null;
  decided_at: number | null;
  decision_comment: string;
}

function rowToSuggestion(r: SuggestionRow): PlanningSuggestion {
  let payload: SuggestionPayload = { placements: [], bottlenecks: [] };
  try {
    const parsed = JSON.parse(r.payload_json) as Partial<SuggestionPayload>;
    payload = {
      placements: Array.isArray(parsed.placements) ? parsed.placements : [],
      bottlenecks: Array.isArray(parsed.bottlenecks) ? parsed.bottlenecks : [],
    };
  } catch {
    // Leave payload as the empty default.
  }
  const status: SuggestionStatus =
    r.status === "accepted" || r.status === "rejected" ? r.status : "pending";
  return {
    id: r.id,
    planningProjectId: r.planning_project_id,
    generatedAt: r.generated_at,
    status,
    payload,
    generatedByUserId: r.generated_by_user_id,
    decidedByUserId: r.decided_by_user_id,
    decidedAt: r.decided_at,
    decisionComment: r.decision_comment,
  };
}

const SELECT_COLS = `id, planning_project_id, generated_at, status,
                     payload_json, generated_by_user_id,
                     decided_by_user_id, decided_at, decision_comment`;

export function getPendingSuggestion(
  db: Database,
  planningProjectId: number,
): PlanningSuggestion | null {
  const row = db
    .prepare(
      `SELECT ${SELECT_COLS} FROM planning_suggestions
        WHERE planning_project_id = ? AND status = 'pending'
        ORDER BY generated_at DESC
        LIMIT 1`,
    )
    .get(planningProjectId) as SuggestionRow | undefined;
  return row ? rowToSuggestion(row) : null;
}

export function getSuggestion(
  db: Database,
  id: number,
): PlanningSuggestion | null {
  const row = db
    .prepare(
      `SELECT ${SELECT_COLS} FROM planning_suggestions WHERE id = ?`,
    )
    .get(id) as SuggestionRow | undefined;
  return row ? rowToSuggestion(row) : null;
}

/**
 * Replace the current pending suggestion for a planning project. Old pending
 * rows are hard-deleted (they have no audit value once superseded); already
 * accepted/rejected rows stay around. Runs in a single transaction.
 */
export function replacePending(
  db: Database,
  planningProjectId: number,
  payload: SuggestionPayload,
  generatedByUserId: string | null,
): PlanningSuggestion {
  const tx = db.transaction(() => {
    db.prepare(
      `DELETE FROM planning_suggestions
        WHERE planning_project_id = ? AND status = 'pending'`,
    ).run(planningProjectId);
    const info = db
      .prepare(
        `INSERT INTO planning_suggestions(planning_project_id, generated_at,
                                          status, payload_json,
                                          generated_by_user_id)
         VALUES (?, ?, 'pending', ?, ?)`,
      )
      .run(
        planningProjectId,
        Date.now(),
        JSON.stringify(payload),
        generatedByUserId,
      );
    return Number(info.lastInsertRowid);
  });
  return getSuggestion(db, tx())!;
}

export function acceptPending(
  db: Database,
  planningProjectId: number,
  decidedByUserId: string,
  comment: string = "",
): PlanningSuggestion | null {
  const pending = getPendingSuggestion(db, planningProjectId);
  if (!pending) return null;
  db.prepare(
    `UPDATE planning_suggestions
       SET status = 'accepted',
           decided_by_user_id = ?,
           decided_at = ?,
           decision_comment = ?
     WHERE id = ?`,
  ).run(decidedByUserId, Date.now(), comment, pending.id);
  return getSuggestion(db, pending.id);
}

export function rejectPending(
  db: Database,
  planningProjectId: number,
  decidedByUserId: string,
  comment: string = "",
): PlanningSuggestion | null {
  const pending = getPendingSuggestion(db, planningProjectId);
  if (!pending) return null;
  db.prepare(
    `UPDATE planning_suggestions
       SET status = 'rejected',
           decided_by_user_id = ?,
           decided_at = ?,
           decision_comment = ?
     WHERE id = ?`,
  ).run(decidedByUserId, Date.now(), comment, pending.id);
  return getSuggestion(db, pending.id);
}

/**
 * Find planning projects whose pending suggestion is missing or older than
 * the most recent edit on any wish/team/deadline/tag in that project. Used
 * by the scheduled refresh handler to decide which projects to recompute.
 */
export function selectStalePlanningProjectIds(
  db: Database,
  limit: number,
): number[] {
  const rows = db
    .prepare(
      `SELECT pp.id
         FROM planning_projects pp
         LEFT JOIN (
           SELECT planning_project_id, MAX(generated_at) AS gen
             FROM planning_suggestions
            WHERE status = 'pending'
            GROUP BY planning_project_id
         ) s ON s.planning_project_id = pp.id
         LEFT JOIN (
           SELECT planning_project_id, MAX(updated_at) AS u FROM planning_wishes
            WHERE deleted_at IS NULL GROUP BY planning_project_id
         ) w ON w.planning_project_id = pp.id
         LEFT JOIN (
           SELECT planning_project_id, MAX(updated_at) AS u FROM planning_teams
            WHERE deleted_at IS NULL GROUP BY planning_project_id
         ) t ON t.planning_project_id = pp.id
         LEFT JOIN (
           SELECT planning_project_id, MAX(updated_at) AS u FROM planning_deadlines
            WHERE deleted_at IS NULL GROUP BY planning_project_id
         ) d ON d.planning_project_id = pp.id
        WHERE pp.deleted_at IS NULL
          AND (
            s.gen IS NULL
            OR (w.u IS NOT NULL AND w.u > s.gen)
            OR (t.u IS NOT NULL AND t.u > s.gen)
            OR (d.u IS NOT NULL AND d.u > s.gen)
            OR pp.updated_at > s.gen
          )
        ORDER BY pp.updated_at DESC
        LIMIT ?`,
    )
    .all(limit) as { id: number }[];
  return rows.map((r) => r.id);
}
