/**
 * Workflow run history — CRUD over `workflow_runs` + `workflow_run_nodes`.
 *
 * One `workflow_runs` row per execution; one `workflow_run_nodes` row per
 * (node, iteration) pair. Iteration 0 = single-shot; loop nodes produce one
 * row per iteration. `log_text` is written once when the node finishes —
 * live SSE subscribers see the stream, post-finish viewers read this column.
 */

import type { Database } from "bun:sqlite";

export type WorkflowRunStatus =
  | "queued"
  | "running"
  | "done"
  | "error"
  | "cancelled"
  | "paused";
export type WorkflowRunTriggerKind = "manual" | "scheduled" | "api";

export type WorkflowNodeStatus =
  | "pending"
  | "running"
  | "waiting"
  | "done"
  | "error"
  | "skipped";

export interface WorkflowRun {
  id: number;
  workflowId: number;
  project: string;
  sessionId: string;
  status: WorkflowRunStatus;
  triggerKind: WorkflowRunTriggerKind;
  triggeredBy: string | null;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  tomlSnapshot: string;
}

/** One structured step inside a node's execution — used by the run timeline UI. */
export type RunStepKind = "text" | "tool" | "bash" | "script";
export interface RunStep {
  kind: RunStepKind;
  /** "content" | "reasoning" for text; tool name for tool; "bash" for bash. */
  label?: string;
  /** Short human-readable summary (first line / args snippet). */
  summary?: string;
  /** Full output / text body. Truncated by the caller if needed. */
  output?: string;
  ok?: boolean;
  error?: string;
  startedAt: number;
  durationMs?: number;
}

export interface WorkflowRunNode {
  id: number;
  runId: number;
  nodeId: string;
  kind: string;
  status: WorkflowNodeStatus;
  iteration: number;
  childSessionId: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  resultText: string | null;
  logText: string | null;
  error: string | null;
  steps: RunStep[];
}

interface RunRow {
  id: number;
  workflow_id: number;
  project: string;
  session_id: string;
  status: string;
  trigger_kind: string;
  triggered_by: string | null;
  started_at: number;
  finished_at: number | null;
  error: string | null;
  toml_snapshot: string;
}

interface NodeRow {
  id: number;
  run_id: number;
  node_id: string;
  kind: string;
  status: string;
  iteration: number;
  child_session_id: string | null;
  started_at: number | null;
  finished_at: number | null;
  result_text: string | null;
  log_text: string | null;
  error: string | null;
  steps_json: string | null;
}

function rowToRun(r: RunRow): WorkflowRun {
  return {
    id: r.id,
    workflowId: r.workflow_id,
    project: r.project,
    sessionId: r.session_id,
    status: r.status as WorkflowRunStatus,
    triggerKind: (r.trigger_kind as WorkflowRunTriggerKind) ?? "manual",
    triggeredBy: r.triggered_by,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    error: r.error,
    tomlSnapshot: r.toml_snapshot,
  };
}

function rowToNode(r: NodeRow): WorkflowRunNode {
  let steps: RunStep[] = [];
  if (r.steps_json) {
    try {
      const parsed = JSON.parse(r.steps_json) as unknown;
      if (Array.isArray(parsed)) steps = parsed as RunStep[];
    } catch {
      steps = [];
    }
  }
  return {
    id: r.id,
    runId: r.run_id,
    nodeId: r.node_id,
    kind: r.kind,
    status: r.status as WorkflowNodeStatus,
    iteration: r.iteration,
    childSessionId: r.child_session_id,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    resultText: r.result_text,
    logText: r.log_text,
    error: r.error,
    steps,
  };
}

const RUN_COLS = `id, workflow_id, project, session_id, status, trigger_kind,
                  triggered_by, started_at, finished_at, error, toml_snapshot`;

const NODE_COLS = `id, run_id, node_id, kind, status, iteration,
                   child_session_id, started_at, finished_at,
                   result_text, log_text, error, steps_json`;

// ── Runs ─────────────────────────────────────────────────────────────────────

export interface CreateRunOpts {
  workflowId: number;
  project: string;
  sessionId: string;
  tomlSnapshot: string;
  triggerKind?: WorkflowRunTriggerKind;
  triggeredBy: string | null;
}

export function createRun(db: Database, opts: CreateRunOpts): WorkflowRun {
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO workflow_runs(
         workflow_id, project, session_id, status, trigger_kind, triggered_by,
         started_at, toml_snapshot
       ) VALUES (?, ?, ?, 'running', ?, ?, ?, ?)`,
    )
    .run(
      opts.workflowId,
      opts.project,
      opts.sessionId,
      opts.triggerKind ?? "manual",
      opts.triggeredBy,
      now,
      opts.tomlSnapshot,
    );
  return getRun(db, Number(info.lastInsertRowid))!;
}

export function getRun(db: Database, id: number): WorkflowRun | null {
  const row = db
    .prepare(`SELECT ${RUN_COLS} FROM workflow_runs WHERE id = ?`)
    .get(id) as RunRow | undefined;
  return row ? rowToRun(row) : null;
}

export function listRunsForWorkflow(
  db: Database,
  workflowId: number,
  limit = 50,
): WorkflowRun[] {
  const rows = db
    .prepare(
      `SELECT ${RUN_COLS} FROM workflow_runs
        WHERE workflow_id = ?
        ORDER BY started_at DESC, id DESC
        LIMIT ?`,
    )
    .all(workflowId, Math.max(1, Math.min(500, limit))) as RunRow[];
  return rows.map(rowToRun);
}

export function markRunDone(db: Database, id: number): void {
  db.prepare(
    `UPDATE workflow_runs SET status = 'done', finished_at = ? WHERE id = ?`,
  ).run(Date.now(), id);
}

export function markRunError(db: Database, id: number, error: string): void {
  db.prepare(
    `UPDATE workflow_runs SET status = 'error', finished_at = ?, error = ? WHERE id = ?`,
  ).run(Date.now(), error, id);
}

export function markRunCancelled(db: Database, id: number): void {
  db.prepare(
    `UPDATE workflow_runs SET status = 'cancelled', finished_at = ? WHERE id = ?`,
  ).run(Date.now(), id);
}

// ── Nodes ────────────────────────────────────────────────────────────────────

export interface CreateRunNodeOpts {
  runId: number;
  nodeId: string;
  kind: string;
  iteration?: number;
  childSessionId?: string | null;
}

/**
 * Insert a run-node row. `iteration` is a hint — if the requested value
 * collides with the UNIQUE(run_id, node_id, iteration) constraint (which
 * can happen when a loop-kind node is also invoked as a body of a
 * for_each), the function falls back to `MAX(iteration)+1` so the insert
 * always succeeds. Callers should treat the returned row's `iteration`
 * as authoritative.
 */
export function createRunNode(
  db: Database,
  opts: CreateRunNodeOpts,
): WorkflowRunNode {
  const now = Date.now();
  const requested = opts.iteration ?? 0;
  const insert = db.prepare(
    `INSERT INTO workflow_run_nodes(
       run_id, node_id, kind, status, iteration, child_session_id, started_at
     ) VALUES (?, ?, ?, 'running', ?, ?, ?)`,
  );
  const attempt = (iter: number): number | null => {
    try {
      const info = insert.run(
        opts.runId,
        opts.nodeId,
        opts.kind,
        iter,
        opts.childSessionId ?? null,
        now,
      );
      return Number(info.lastInsertRowid);
    } catch (e) {
      if (
        String((e as Error).message ?? e)
          .toLowerCase()
          .includes("unique")
      ) {
        return null;
      }
      throw e;
    }
  };
  let id = attempt(requested);
  if (id === null) {
    const row = db
      .prepare(
        `SELECT COALESCE(MAX(iteration), -1) AS m
           FROM workflow_run_nodes
          WHERE run_id = ? AND node_id = ?`,
      )
      .get(opts.runId, opts.nodeId) as { m: number };
    id = attempt(row.m + 1);
    if (id === null) throw new Error("could not allocate iteration");
  }
  return getRunNode(db, id)!;
}

export function getRunNode(db: Database, id: number): WorkflowRunNode | null {
  const row = db
    .prepare(`SELECT ${NODE_COLS} FROM workflow_run_nodes WHERE id = ?`)
    .get(id) as NodeRow | undefined;
  return row ? rowToNode(row) : null;
}

export function listRunNodes(db: Database, runId: number): WorkflowRunNode[] {
  const rows = db
    .prepare(
      `SELECT ${NODE_COLS} FROM workflow_run_nodes
        WHERE run_id = ? ORDER BY id ASC`,
    )
    .all(runId) as NodeRow[];
  return rows.map(rowToNode);
}

/**
 * Lean alternative to `listRunNodes` for the interactive-gate prior-results
 * summary. Returns only the few most-recent terminal rows, with `result_text`
 * / `error` truncated to 400 chars. Avoids pulling the full `log_text` +
 * `steps_json` blobs which can be megabytes on long-running nodes.
 */
export interface RunNodeSummary {
  nodeId: string;
  iteration: number;
  status: WorkflowNodeStatus;
  resultText: string | null;
  error: string | null;
}
export function listRecentRunNodeSummaries(
  db: Database,
  runId: number,
  limit: number,
): RunNodeSummary[] {
  interface Row {
    node_id: string;
    iteration: number;
    status: string;
    result_text: string | null;
    error: string | null;
  }
  const rows = db
    .prepare(
      `SELECT node_id,
              iteration,
              status,
              substr(result_text, 1, 400) AS result_text,
              substr(error, 1, 400) AS error
         FROM workflow_run_nodes
        WHERE run_id = ? AND status IN ('done', 'error')
        ORDER BY id DESC
        LIMIT ?`,
    )
    .all(runId, Math.max(1, limit)) as Row[];
  return rows
    .map((r) => ({
      nodeId: r.node_id,
      iteration: r.iteration,
      status: r.status as WorkflowNodeStatus,
      resultText: r.result_text,
      error: r.error,
    }))
    .reverse();
}

export interface MarkNodeDoneOpts {
  resultText?: string | null;
  logText?: string | null;
  steps?: RunStep[] | null;
}

export function markNodeDone(
  db: Database,
  id: number,
  opts: MarkNodeDoneOpts = {},
): void {
  const stepsJson =
    opts.steps === null || opts.steps === undefined
      ? null
      : JSON.stringify(opts.steps);
  db.prepare(
    `UPDATE workflow_run_nodes
        SET status = 'done', finished_at = ?, result_text = ?, log_text = ?, steps_json = ?
      WHERE id = ?`,
  ).run(
    Date.now(),
    opts.resultText ?? null,
    opts.logText ?? null,
    stepsJson,
    id,
  );
}

export function markNodeError(
  db: Database,
  id: number,
  error: string,
  logText?: string | null,
  steps?: RunStep[] | null,
): void {
  const stepsJson =
    steps === null || steps === undefined ? null : JSON.stringify(steps);
  db.prepare(
    `UPDATE workflow_run_nodes
        SET status = 'error', finished_at = ?, error = ?,
            log_text = COALESCE(?, log_text),
            steps_json = COALESCE(?, steps_json)
      WHERE id = ?`,
  ).run(Date.now(), error, logText ?? null, stepsJson, id);
}

export function markNodeWaiting(db: Database, id: number): void {
  db.prepare(
    `UPDATE workflow_run_nodes SET status = 'waiting' WHERE id = ?`,
  ).run(id);
}

export function markNodeSkipped(db: Database, id: number): void {
  db.prepare(
    `UPDATE workflow_run_nodes
        SET status = 'skipped', finished_at = ?
      WHERE id = ?`,
  ).run(Date.now(), id);
}

/** Look up a node record for a historical log fetch. */
export function findRunNodeByNodeId(
  db: Database,
  runId: number,
  nodeId: string,
  iteration?: number,
): WorkflowRunNode | null {
  const row =
    iteration === undefined
      ? (db
          .prepare(
            `SELECT ${NODE_COLS} FROM workflow_run_nodes
              WHERE run_id = ? AND node_id = ?
              ORDER BY iteration DESC, id DESC LIMIT 1`,
          )
          .get(runId, nodeId) as NodeRow | undefined)
      : (db
          .prepare(
            `SELECT ${NODE_COLS} FROM workflow_run_nodes
              WHERE run_id = ? AND node_id = ? AND iteration = ?`,
          )
          .get(runId, nodeId, iteration) as NodeRow | undefined);
  return row ? rowToNode(row) : null;
}
