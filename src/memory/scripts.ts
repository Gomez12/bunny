/**
 * Scripts subsystem — DB CRUD, versioning, and disk-path helpers.
 *
 * Scripts are scoped to a code_project and stored both in the DB (versioned)
 * and on disk at workspace/code/<code-project-name>/scripts/<name>.<ext>.
 * Temp scripts (is_temp=1) live in scripts/temp/ and are hidden by default.
 *
 * See docs/dev/entities/scripts.md, ADR 0037.
 */

import type { Database } from "bun:sqlite";
import { join } from "node:path";
import type { User } from "../auth/users.ts";
import { validateSlugName } from "./slug.ts";
import { registerTrashable, softDelete } from "./trash.ts";
import { registerVersionable } from "./versioning.ts";
import { projectScopedAccess } from "./versioning_access.ts";
import type { Project } from "./projects.ts";

export const SCRIPT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export type ScriptLanguage =
  | "javascript"
  | "typescript"
  | "csharp"
  | "python"
  | "sql"
  | "bash"
  | "powershell"
  | "go";

const VALID_LANGUAGES: readonly ScriptLanguage[] = [
  "javascript",
  "typescript",
  "csharp",
  "python",
  "sql",
  "bash",
  "powershell",
  "go",
];

export const LANGUAGE_TO_EXT: Record<ScriptLanguage, string> = {
  javascript: ".js",
  typescript: ".ts",
  csharp: ".cs",
  python: ".py",
  sql: ".sql",
  bash: ".sh",
  powershell: ".ps1",
  go: ".go",
};

export const EXT_TO_LANGUAGE: Record<string, ScriptLanguage> = {
  ".js": "javascript",
  ".ts": "typescript",
  ".cs": "csharp",
  ".py": "python",
  ".sql": "sql",
  ".sh": "bash",
  ".ps1": "powershell",
  ".go": "go",
};

export interface Script {
  id: number;
  codeProjectId: number;
  project: string;
  name: string;
  description: string;
  content: string;
  language: ScriptLanguage;
  isTemp: boolean;
  fileHash: string | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ScriptVersion {
  id: number;
  scriptId: number;
  content: string;
  createdBy: string | null;
  createdAt: number;
}

interface ScriptRow {
  id: number;
  code_project_id: number;
  project: string;
  name: string;
  description: string;
  content: string;
  language: string;
  is_temp: number;
  file_hash: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

interface ScriptVersionRow {
  id: number;
  script_id: number;
  content: string;
  created_by: string | null;
  created_at: number;
}

registerTrashable({
  kind: "script",
  table: "scripts",
  nameColumn: "name",
  hasUniqueName: true,
  scopeColumn: "code_project_id",
  translationSidecarTable: null,
  translationSidecarFk: null,
});

// Scripts pre-date the universal versioning system: `script_versions` is its
// own append-only table written by the legacy `appendScriptVersion` path used
// by `ScriptVersionsView`. We register `script` here so the trash hook + new
// generic UI work for free; a one-time backfill into `entity_versions` (plan
// §7) is tracked separately and not run from this registration.
// `file_hash` is omitted from the snapshot because it's a side-effect of
// `content` and resyncs on the next disk write.
registerVersionable({
  kind: "script",
  table: "scripts",
  primaryKey: "id",
  sidecars: [
    "script_versions (legacy chain — backfill into entity_versions tracked separately)",
  ],
  snapshot(db, id) {
    const row = db
      .prepare(
        `SELECT id, code_project_id, project, name, description, content,
                language, is_temp, created_by, created_at, updated_at
           FROM scripts WHERE id = ?`,
      )
      .get(Number(id)) as Record<string, unknown> | undefined;
    return row ? { ...row } : null;
  },
  restore(db, id, snapshot) {
    db.prepare(
      `UPDATE scripts
          SET name = ?, description = ?, content = ?, language = ?,
              is_temp = ?, updated_at = ?
        WHERE id = ?`,
    ).run(
      String(snapshot["name"] ?? ""),
      String(snapshot["description"] ?? ""),
      String(snapshot["content"] ?? ""),
      String(snapshot["language"] ?? "javascript"),
      Number(snapshot["is_temp"] ?? 0),
      Date.now(),
      Number(id),
    );
  },
  canSee: (db, userId, id) =>
    projectScopedAccess(db, userId, "scripts", "id", id, "see"),
  canEdit: (db, userId, id) =>
    projectScopedAccess(db, userId, "scripts", "id", id, "edit"),
});

function rowToScript(r: ScriptRow): Script {
  const lang = (VALID_LANGUAGES as readonly string[]).includes(r.language)
    ? (r.language as ScriptLanguage)
    : "javascript";
  return {
    id: r.id,
    codeProjectId: r.code_project_id,
    project: r.project,
    name: r.name,
    description: r.description,
    content: r.content,
    language: lang,
    isTemp: r.is_temp === 1,
    fileHash: r.file_hash,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToVersion(r: ScriptVersionRow): ScriptVersion {
  return {
    id: r.id,
    scriptId: r.script_id,
    content: r.content,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

// ── Disk-path helpers ────────────────────────────────────────────────────────

/** Workspace-relative path for a script file (no leading slash). */
export function scriptRelPath(
  codeProjectName: string,
  scriptName: string,
  language: ScriptLanguage,
  isTemp: boolean,
): string {
  const ext = LANGUAGE_TO_EXT[language];
  const subdir = isTemp ? "temp" : "";
  return subdir
    ? `code/${codeProjectName}/scripts/temp/${scriptName}${ext}`
    : `code/${codeProjectName}/scripts/${scriptName}${ext}`;
}

/** Absolute disk path for a script. */
export function scriptAbsPath(
  workspaceRoot: string,
  codeProjectName: string,
  scriptName: string,
  language: ScriptLanguage,
  isTemp: boolean,
): string {
  return join(
    workspaceRoot,
    scriptRelPath(codeProjectName, scriptName, language, isTemp),
  );
}

/** Workspace-relative path for an execution temp file. */
export function scriptRunTmpRelPath(
  codeProjectName: string,
  scriptId: number,
  language: ScriptLanguage,
): string {
  const ext = LANGUAGE_TO_EXT[language];
  return `code/${codeProjectName}/scripts-tmp/${scriptId}${ext}`;
}

// ── Name generation ─────────────────────────────────────────────────────────

/** Generate a unique temp-script name including a short random suffix. */
export function generateTempName(): string {
  const now = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const datePart = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
  ].join("");
  const timePart = [
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
  const suffix = Math.random().toString(36).slice(2, 5);
  return `scratch-${datePart}-${timePart}-${suffix}`;
}

// ── CRUD ────────────────────────────────────────────────────────────────────

export function listScripts(
  db: Database,
  codeProjectId: number,
  opts: { includeTemp?: boolean } = {},
): Script[] {
  const tempFilter = opts.includeTemp ? "" : "AND is_temp = 0";
  const rows = db
    .prepare(
      `SELECT * FROM scripts
        WHERE code_project_id = ?
          AND deleted_at IS NULL
          ${tempFilter}
        ORDER BY updated_at DESC`,
    )
    .all(codeProjectId) as ScriptRow[];
  return rows.map(rowToScript);
}

export function getScript(db: Database, id: number): Script | undefined {
  const row = db
    .prepare(`SELECT * FROM scripts WHERE id = ? AND deleted_at IS NULL`)
    .get(id) as ScriptRow | undefined;
  return row ? rowToScript(row) : undefined;
}

export interface CreateScriptOpts {
  codeProjectId: number;
  project: string;
  /** Optional when isTemp = true — auto-generated if omitted. */
  name?: string;
  description?: string;
  content?: string;
  language?: ScriptLanguage;
  isTemp?: boolean;
  createdBy?: string;
}

export function createScript(db: Database, opts: CreateScriptOpts): Script {
  const isTemp = opts.isTemp ?? false;
  const name = opts.name
    ? validateSlugName(opts.name, SCRIPT_NAME_RE, "script")
    : isTemp
      ? generateTempName()
      : (() => {
          throw new Error("script name is required for non-temp scripts");
        })();
  const language = opts.language ?? "javascript";
  const now = Date.now();

  const result = db
    .prepare(
      `INSERT INTO scripts
         (code_project_id, project, name, description, content, language,
          is_temp, file_hash, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
       RETURNING *`,
    )
    .get(
      opts.codeProjectId,
      opts.project,
      name,
      opts.description ?? "",
      opts.content ?? "",
      language,
      isTemp ? 1 : 0,
      opts.createdBy ?? null,
      now,
      now,
    ) as ScriptRow;
  return rowToScript(result);
}

export interface UpdateScriptPatch {
  name?: string;
  description?: string;
  content?: string;
  language?: ScriptLanguage;
  isTemp?: boolean;
  fileHash?: string | null;
}

/**
 * Update a script. Pass `createVersion: true` to snapshot the current
 * content in `script_versions` before writing the new content.
 * Auto-save calls should NOT pass createVersion; blur/idle calls should.
 */
export function updateScript(
  db: Database,
  id: number,
  patch: UpdateScriptPatch,
  opts: { createdBy?: string; createVersion?: boolean } = {},
): Script | undefined {
  const existing = getScript(db, id);
  if (!existing) return undefined;

  const now = Date.now();

  const tx = db.transaction(() => {
    if (opts.createVersion && patch.content !== undefined && patch.content !== existing.content) {
      db.prepare(
        `INSERT INTO script_versions (script_id, content, created_by, created_at)
         VALUES (?, ?, ?, ?)`,
      ).run(id, existing.content, opts.createdBy ?? null, now);

    }

    const name = patch.name
      ? validateSlugName(patch.name, SCRIPT_NAME_RE, "script")
      : existing.name;

    db.prepare(
      `UPDATE scripts
          SET name = ?, description = ?, content = ?, language = ?,
              is_temp = ?, file_hash = ?, updated_at = ?
        WHERE id = ?`,
    ).run(
      name,
      patch.description ?? existing.description,
      patch.content ?? existing.content,
      patch.language ?? existing.language,
      patch.isTemp !== undefined ? (patch.isTemp ? 1 : 0) : existing.isTemp ? 1 : 0,
      patch.fileHash !== undefined ? patch.fileHash : existing.fileHash,
      now,
      id,
    );
  });
  tx();

  return getScript(db, id);
}

/** Delete oldest versions beyond maxCount for a script. */
export function pruneScriptVersions(
  db: Database,
  scriptId: number,
  maxCount: number,
): void {
  db.prepare(
    `DELETE FROM script_versions
      WHERE script_id = ?
        AND id NOT IN (
          SELECT id FROM script_versions
           WHERE script_id = ?
           ORDER BY created_at DESC
           LIMIT ?
        )`,
  ).run(scriptId, scriptId, maxCount);
}

export function deleteScript(
  db: Database,
  id: number,
  userId: string | null,
): boolean {
  return softDelete(db, "script", id, userId);
}

/** Set is_temp = 0. The caller must handle moving the disk file. */
export function promoteScript(db: Database, id: number): boolean {
  const result = db
    .prepare(
      `UPDATE scripts SET is_temp = 0, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
    )
    .run(Date.now(), id);
  return result.changes > 0;
}

// ── Versions ────────────────────────────────────────────────────────────────

export function listScriptVersions(
  db: Database,
  scriptId: number,
  limit = 50,
): ScriptVersion[] {
  const rows = db
    .prepare(
      `SELECT * FROM script_versions
        WHERE script_id = ?
        ORDER BY created_at DESC
        LIMIT ?`,
    )
    .all(scriptId, limit) as ScriptVersionRow[];
  return rows.map(rowToVersion);
}

export function getScriptVersion(
  db: Database,
  versionId: number,
): ScriptVersion | undefined {
  const row = db
    .prepare(`SELECT * FROM script_versions WHERE id = ?`)
    .get(versionId) as ScriptVersionRow | undefined;
  return row ? rowToVersion(row) : undefined;
}

// ── Permissions ─────────────────────────────────────────────────────────────

export function canEditScript(
  user: User,
  script: Script,
  project: Project | { name: string },
): boolean {
  if (user.role === "admin") return true;
  if (script.project !== project.name) return false;
  return script.createdBy === user.id;
}
