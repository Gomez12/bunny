/**
 * Workflows — DB CRUD over the `workflows` index table. The TOML content
 * itself lives on disk (see `workflow_assets.ts`); this row stores the slug,
 * display name, layout, drift-detection hash, and per-node bash-approval map.
 */

import type { Database } from "bun:sqlite";
import { validateSlugName } from "./slug.ts";
import { registerTrashable } from "./trash.ts";

/** Slug rule — doubles as the TOML filename stem. */
export const WORKFLOW_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function validateWorkflowSlug(raw: unknown): string {
  return validateSlugName(raw, WORKFLOW_SLUG_RE, "workflow slug");
}

registerTrashable({
  kind: "workflow",
  table: "workflows",
  nameColumn: "slug",
  hasUniqueName: true,
  translationSidecarTable: null,
  translationSidecarFk: null,
});

export interface Workflow {
  id: number;
  project: string;
  slug: string;
  name: string;
  description: string | null;
  tomlSha256: string;
  layoutJson: string | null;
  bashApprovals: Record<string, string>;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

interface WorkflowRow {
  id: number;
  project: string;
  slug: string;
  name: string;
  description: string | null;
  toml_sha256: string;
  layout_json: string | null;
  bash_approvals: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

function rowToWorkflow(r: WorkflowRow): Workflow {
  let approvals: Record<string, string> = {};
  if (r.bash_approvals) {
    try {
      const parsed = JSON.parse(r.bash_approvals) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        approvals = parsed as Record<string, string>;
      }
    } catch {
      approvals = {};
    }
  }
  return {
    id: r.id,
    project: r.project,
    slug: r.slug,
    name: r.name,
    description: r.description,
    tomlSha256: r.toml_sha256,
    layoutJson: r.layout_json,
    bashApprovals: approvals,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const SELECT_COLS = `id, project, slug, name, description, toml_sha256,
                     layout_json, bash_approvals, created_by, created_at, updated_at`;

export function listWorkflows(db: Database, project: string): Workflow[] {
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLS} FROM workflows
        WHERE project = ? AND deleted_at IS NULL
        ORDER BY updated_at DESC`,
    )
    .all(project) as WorkflowRow[];
  return rows.map(rowToWorkflow);
}

export function getWorkflow(db: Database, id: number): Workflow | null {
  const row = db
    .prepare(
      `SELECT ${SELECT_COLS} FROM workflows
        WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(id) as WorkflowRow | undefined;
  return row ? rowToWorkflow(row) : null;
}

export function getWorkflowBySlug(
  db: Database,
  project: string,
  slug: string,
): Workflow | null {
  const row = db
    .prepare(
      `SELECT ${SELECT_COLS} FROM workflows
        WHERE project = ? AND slug = ? AND deleted_at IS NULL`,
    )
    .get(project, slug) as WorkflowRow | undefined;
  return row ? rowToWorkflow(row) : null;
}

export interface CreateWorkflowOpts {
  project: string;
  slug: string;
  name: string;
  description?: string | null;
  tomlSha256: string;
  layoutJson?: string | null;
  createdBy: string;
}

export function createWorkflow(
  db: Database,
  opts: CreateWorkflowOpts,
): Workflow {
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO workflows(
         project, slug, name, description, toml_sha256, layout_json,
         bash_approvals, created_by, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?, ?)`,
    )
    .run(
      opts.project,
      opts.slug,
      opts.name,
      opts.description ?? null,
      opts.tomlSha256,
      opts.layoutJson ?? null,
      opts.createdBy,
      now,
      now,
    );
  return getWorkflow(db, Number(info.lastInsertRowid))!;
}

export interface UpdateWorkflowOpts {
  name?: string;
  description?: string | null;
  tomlSha256?: string;
  layoutJson?: string | null;
  bashApprovals?: Record<string, string>;
}

export function updateWorkflow(
  db: Database,
  id: number,
  opts: UpdateWorkflowOpts,
): Workflow {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (opts.name !== undefined) {
    sets.push(`name = ?`);
    params.push(opts.name);
  }
  if (opts.description !== undefined) {
    sets.push(`description = ?`);
    params.push(opts.description);
  }
  if (opts.tomlSha256 !== undefined) {
    sets.push(`toml_sha256 = ?`);
    params.push(opts.tomlSha256);
  }
  if (opts.layoutJson !== undefined) {
    sets.push(`layout_json = ?`);
    params.push(opts.layoutJson);
  }
  if (opts.bashApprovals !== undefined) {
    sets.push(`bash_approvals = ?`);
    params.push(JSON.stringify(opts.bashApprovals));
  }
  sets.push(`updated_at = ?`);
  params.push(Date.now());
  params.push(id);
  db.prepare(`UPDATE workflows SET ${sets.join(", ")} WHERE id = ?`).run(
    ...(params as never[]),
  );
  return getWorkflow(db, id)!;
}

/**
 * Upsert a bash-approval hash for one (workflow, nodeId). Callers atomic-ish:
 * reads the current map, mutates, writes — wrap in a transaction at the
 * route/engine layer if higher concurrency appears.
 */
export function grantBashApproval(
  db: Database,
  workflowId: number,
  nodeId: string,
  cmdSha: string,
): void {
  const wf = getWorkflow(db, workflowId);
  if (!wf) return;
  const next = { ...wf.bashApprovals, [nodeId]: cmdSha };
  db.prepare(
    `UPDATE workflows SET bash_approvals = ?, updated_at = ? WHERE id = ?`,
  ).run(JSON.stringify(next), Date.now(), workflowId);
}
