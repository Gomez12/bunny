/**
 * Per-(user, project) UI preferences stored in `user_project_prefs.prefs_json`.
 *
 * Stores selections that are meaningful within a specific project context
 * and should follow the user across devices.
 */

import type { Database } from "bun:sqlite";

export interface ProjectUiPrefs {
  activeCodeProjectId?: number;
  activeDiagramId?: number;
  activeWorkflowId?: number;
  hiddenTopicIds?: number[];
}

const ALLOWED_KEYS = new Set<string>([
  "activeCodeProjectId",
  "activeDiagramId",
  "activeWorkflowId",
  "hiddenTopicIds",
]);

export function parseProjectUiPrefs(raw: string): ProjectUiPrefs {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const out: ProjectUiPrefs = {};
    const cpId = obj["activeCodeProjectId"];
    if (typeof cpId === "number") out.activeCodeProjectId = cpId;
    const dgId = obj["activeDiagramId"];
    if (typeof dgId === "number") out.activeDiagramId = dgId;
    const wfId = obj["activeWorkflowId"];
    if (typeof wfId === "number") out.activeWorkflowId = wfId;
    const hiddenIds = obj["hiddenTopicIds"];
    if (
      Array.isArray(hiddenIds) &&
      (hiddenIds as unknown[]).every((n) => typeof n === "number")
    ) {
      out.hiddenTopicIds = hiddenIds as number[];
    }
    return out;
  } catch {
    return {};
  }
}

export function validateProjectUiPrefsPatch(patch: unknown): ProjectUiPrefs {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("prefs must be an object");
  }
  const p = patch as Record<string, unknown>;
  const unknownKeys = Object.keys(p).filter((k) => !ALLOWED_KEYS.has(k));
  if (unknownKeys.length) throw new Error(`unknown pref keys: ${unknownKeys.join(", ")}`);

  const out: ProjectUiPrefs = {};
  if ("activeCodeProjectId" in p) {
    const v = p["activeCodeProjectId"];
    if (v !== null && typeof v !== "number")
      throw new Error("activeCodeProjectId must be a number or null");
    if (typeof v === "number") out.activeCodeProjectId = v;
  }
  if ("activeDiagramId" in p) {
    const v = p["activeDiagramId"];
    if (v !== null && typeof v !== "number")
      throw new Error("activeDiagramId must be a number or null");
    if (typeof v === "number") out.activeDiagramId = v;
  }
  if ("activeWorkflowId" in p) {
    const v = p["activeWorkflowId"];
    if (v !== null && typeof v !== "number")
      throw new Error("activeWorkflowId must be a number or null");
    if (typeof v === "number") out.activeWorkflowId = v;
  }
  if ("hiddenTopicIds" in p) {
    const v = p["hiddenTopicIds"];
    if (
      !Array.isArray(v) ||
      !(v as unknown[]).every((n) => typeof n === "number")
    )
      throw new Error("hiddenTopicIds must be an array of numbers");
    out.hiddenTopicIds = v as number[];
  }
  return out;
}

export function getUserProjectPrefs(
  db: Database,
  userId: string,
  project: string,
): ProjectUiPrefs {
  const row = db
    .prepare(
      "SELECT prefs_json FROM user_project_prefs WHERE user_id = ? AND project = ?",
    )
    .get(userId, project) as { prefs_json: string } | null;
  return row ? parseProjectUiPrefs(row.prefs_json) : {};
}

export function setUserProjectPrefs(
  db: Database,
  userId: string,
  project: string,
  patch: ProjectUiPrefs,
): ProjectUiPrefs {
  const current = getUserProjectPrefs(db, userId, project);
  const next: ProjectUiPrefs = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    (next as Record<string, unknown>)[k] = v;
  }
  db.prepare(
    `INSERT INTO user_project_prefs (user_id, project, prefs_json, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, project) DO UPDATE
       SET prefs_json = excluded.prefs_json, updated_at = excluded.updated_at`,
  ).run(userId, project, JSON.stringify(next), Date.now());
  return next;
}
