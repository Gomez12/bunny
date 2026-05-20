/**
 * Agent registry — CRUD over the `agents` table and the `project_agents`
 * opt-in join table.
 *
 * An agent is a named personality (prompt + tools + memory knobs). The DB row
 * stores metadata; `agent_assets.ts` owns the on-disk TOML config. Availability
 * inside a project is opt-in via {@link linkAgentToProject}.
 */

import type { Database } from "bun:sqlite";
import { AGENT_NAME_RE } from "./agent_name.ts";
import { validateSlugName } from "./slug.ts";
import { registerVersionable } from "./versioning.ts";

// Agents have no soft-delete (hard delete) and the on-disk TOML lives in
// agent_assets.ts; the version chain captures the DB-row metadata only.
// `name` is the primary key — restore is a metadata-only UPDATE (the name
// itself is immutable post-create, just like script slugs).
registerVersionable({
  kind: "agent",
  table: "agents",
  primaryKey: "name",
  sidecars: ["agent TOML on disk (out of scope — see agent_assets.ts)"],
  snapshot(db, id) {
    const row = db
      .prepare(
        `SELECT name, description, visibility, is_subagent, knows_other_agents,
                context_scope, created_by, created_at, updated_at
           FROM agents WHERE name = ?`,
      )
      .get(String(id)) as Record<string, unknown> | undefined;
    return row ? { ...row } : null;
  },
  restore(db, id, snapshot) {
    db.prepare(
      `UPDATE agents
          SET description = ?, visibility = ?, is_subagent = ?,
              knows_other_agents = ?, context_scope = ?, updated_at = ?
        WHERE name = ?`,
    ).run(
      String(snapshot["description"] ?? ""),
      String(snapshot["visibility"] ?? "private"),
      Number(snapshot["is_subagent"] ?? 0),
      Number(snapshot["knows_other_agents"] ?? 0),
      String(snapshot["context_scope"] ?? "full"),
      Date.now(),
      String(id),
    );
  },
  // Agents follow their own visibility flag: public agents are readable by
  // every authenticated user; private ones only by their creator. Restore is
  // creator-only because it overwrites the prompt/visibility config.
  canSee: (db, userId, name) => {
    const row = db
      .prepare(`SELECT visibility, created_by FROM agents WHERE name = ?`)
      .get(name) as { visibility: string; created_by: string | null } | undefined;
    if (!row) return false;
    if (row.visibility === "public") return true;
    return row.created_by === userId;
  },
  canEdit: (db, userId, name) => {
    const row = db
      .prepare(`SELECT created_by FROM agents WHERE name = ?`)
      .get(name) as { created_by: string | null } | undefined;
    return row?.created_by === userId;
  },
});

export type AgentVisibility = "public" | "private";
export type AgentContextScope = "full" | "own";

export interface Agent {
  name: string;
  description: string;
  visibility: AgentVisibility;
  isSubagent: boolean;
  knowsOtherAgents: boolean;
  contextScope: AgentContextScope;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

export { AGENT_NAME_RE };

/** Validate and normalise an agent name. Throws on invalid input. */
export function validateAgentName(raw: unknown): string {
  return validateSlugName(raw, AGENT_NAME_RE, "agent");
}

interface AgentRow {
  name: string;
  description: string;
  visibility: string;
  is_subagent: number;
  knows_other_agents: number;
  context_scope: string;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

function rowToAgent(r: AgentRow): Agent {
  return {
    name: r.name,
    description: r.description ?? "",
    visibility: r.visibility === "public" ? "public" : "private",
    isSubagent: r.is_subagent === 1,
    knowsOtherAgents: r.knows_other_agents === 1,
    contextScope: r.context_scope === "own" ? "own" : "full",
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const SELECT_COLUMNS = `name, description, visibility, is_subagent, knows_other_agents,
                        context_scope, created_by, created_at, updated_at`;

export function listAgents(db: Database): Agent[] {
  const rows = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM agents ORDER BY name ASC`)
    .all() as AgentRow[];
  return rows.map(rowToAgent);
}

export function getAgent(db: Database, name: string): Agent | null {
  const row = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM agents WHERE name = ?`)
    .get(name) as AgentRow | undefined;
  return row ? rowToAgent(row) : null;
}

export interface CreateAgentOpts {
  name: string;
  description?: string | null;
  visibility?: AgentVisibility;
  isSubagent?: boolean;
  knowsOtherAgents?: boolean;
  contextScope?: AgentContextScope;
  createdBy?: string | null;
}

export function createAgent(db: Database, opts: CreateAgentOpts): Agent {
  const name = validateAgentName(opts.name);
  const now = Date.now();
  db.prepare(
    `INSERT INTO agents(name, description, visibility, is_subagent, knows_other_agents,
                        context_scope, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    name,
    opts.description ?? "",
    opts.visibility ?? "private",
    opts.isSubagent ? 1 : 0,
    opts.knowsOtherAgents ? 1 : 0,
    opts.contextScope ?? "full",
    opts.createdBy ?? null,
    now,
    now,
  );
  return getAgent(db, name)!;
}

export interface UpdateAgentPatch {
  description?: string | null;
  visibility?: AgentVisibility;
  isSubagent?: boolean;
  knowsOtherAgents?: boolean;
  contextScope?: AgentContextScope;
}

export function updateAgent(
  db: Database,
  name: string,
  patch: UpdateAgentPatch,
): Agent {
  const existing = getAgent(db, name);
  if (!existing) throw new Error(`agent '${name}' not found`);
  const description =
    patch.description === undefined
      ? existing.description
      : (patch.description ?? "");
  const visibility = patch.visibility ?? existing.visibility;
  const isSubagent =
    patch.isSubagent === undefined ? existing.isSubagent : patch.isSubagent;
  const knowsOther =
    patch.knowsOtherAgents === undefined
      ? existing.knowsOtherAgents
      : patch.knowsOtherAgents;
  const contextScope = patch.contextScope ?? existing.contextScope;
  db.prepare(
    `UPDATE agents
     SET description = ?, visibility = ?, is_subagent = ?, knows_other_agents = ?,
         context_scope = ?, updated_at = ?
     WHERE name = ?`,
  ).run(
    description,
    visibility,
    isSubagent ? 1 : 0,
    knowsOther ? 1 : 0,
    contextScope,
    Date.now(),
    name,
  );
  return getAgent(db, name)!;
}

/** Remove an agent and all its project links. On-disk config is left alone. */
export function deleteAgent(db: Database, name: string): void {
  db.prepare(`DELETE FROM project_agents WHERE agent = ?`).run(name);
  db.prepare(`DELETE FROM agents WHERE name = ?`).run(name);
}

// ── Project ↔ Agent links ──────────────────────────────────────────────────

export function linkAgentToProject(
  db: Database,
  project: string,
  agent: string,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO project_agents(project, agent) VALUES (?, ?)`,
  ).run(project, agent);
}

export function unlinkAgentFromProject(
  db: Database,
  project: string,
  agent: string,
): void {
  db.prepare(`DELETE FROM project_agents WHERE project = ? AND agent = ?`).run(
    project,
    agent,
  );
}

export function listAgentsForProject(db: Database, project: string): Agent[] {
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLUMNS.split(",")
        .map((c) => "a." + c.trim())
        .join(", ")}
       FROM project_agents pa
       JOIN agents a ON a.name = pa.agent
       WHERE pa.project = ?
       ORDER BY a.name ASC`,
    )
    .all(project) as AgentRow[];
  return rows.map(rowToAgent);
}

/** Projects this agent is linked to. */
export function listProjectsForAgent(db: Database, agent: string): string[] {
  const rows = db
    .prepare(
      `SELECT project FROM project_agents WHERE agent = ? ORDER BY project ASC`,
    )
    .all(agent) as Array<{ project: string }>;
  return rows.map((r) => r.project);
}

/**
 * Fetch the project list for many agents in a single query. Returns a map
 * keyed by agent name with sorted project names as the value. Unknown agents
 * are omitted. Cheaper than N calls to {@link listProjectsForAgent} when
 * building DTOs for a list view.
 */
export function mapProjectsByAgent(db: Database): Map<string, string[]> {
  const rows = db
    .prepare(
      `SELECT agent, project FROM project_agents ORDER BY agent ASC, project ASC`,
    )
    .all() as Array<{ agent: string; project: string }>;
  const out = new Map<string, string[]>();
  for (const { agent, project } of rows) {
    const list = out.get(agent);
    if (list) list.push(project);
    else out.set(agent, [project]);
  }
  return out;
}

export function isAgentLinkedToProject(
  db: Database,
  project: string,
  agent: string,
): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM project_agents WHERE project = ? AND agent = ? LIMIT 1`,
    )
    .get(project, agent) as { ok: number } | undefined;
  return !!row;
}
