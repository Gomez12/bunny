/**
 * DB CRUD and runtime helpers for code-project secrets.
 *
 * Secrets are key-value pairs scoped to a code-project. They are referenced in
 * script content via the {{secret:NAME}} tag syntax (substituted before execution)
 * or as process.env.NAME (injected as environment variables). See ADR 0039.
 */

import type { Database } from "bun:sqlite";

// Name must start with an uppercase letter, followed by uppercase letters,
// digits, or underscores — valid both as a tag identifier and an env-var name.
export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

// Matches {{secret:NAME}} occurrences in script content.
export const SECRET_TAG_RE = /\{\{secret:([A-Z][A-Z0-9_]*)\}\}/g;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CodeProjectSecret {
  id: number;
  codeProjectId: number;
  name: string;
  description: string;
  value: string;
  isViewable: boolean;
  llmForbidden: boolean;
  lastUsedAt: number | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

interface SecretRow {
  id: number;
  code_project_id: number;
  name: string;
  description: string;
  value: string;
  is_viewable: number;
  llm_forbidden: number;
  last_used_at: number | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

function rowToSecret(r: SecretRow): CodeProjectSecret {
  return {
    id: r.id,
    codeProjectId: r.code_project_id,
    name: r.name,
    description: r.description,
    value: r.value,
    isViewable: r.is_viewable === 1,
    llmForbidden: r.llm_forbidden === 1,
    lastUsedAt: r.last_used_at,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

export function listSecrets(
  db: Database,
  codeProjectId: number,
): CodeProjectSecret[] {
  const rows = db
    .prepare(
      `SELECT * FROM code_project_secrets WHERE code_project_id = ? ORDER BY name ASC`,
    )
    .all(codeProjectId) as SecretRow[];
  return rows.map(rowToSecret);
}

export function listSecretNames(
  db: Database,
  codeProjectId: number,
): { name: string; description: string }[] {
  return db
    .prepare(
      `SELECT name, description FROM code_project_secrets WHERE code_project_id = ? ORDER BY name ASC`,
    )
    .all(codeProjectId) as { name: string; description: string }[];
}

export function getSecret(
  db: Database,
  id: number,
): CodeProjectSecret | undefined {
  const row = db
    .prepare(`SELECT * FROM code_project_secrets WHERE id = ?`)
    .get(id) as SecretRow | undefined;
  return row ? rowToSecret(row) : undefined;
}

export interface CreateSecretOpts {
  codeProjectId: number;
  name: string;
  description?: string;
  value: string;
  isViewable?: boolean;
  llmForbidden?: boolean;
  createdBy?: string;
}

export function createSecret(
  db: Database,
  opts: CreateSecretOpts,
): CodeProjectSecret {
  if (!SECRET_NAME_RE.test(opts.name)) {
    throw new Error(
      `Invalid secret name '${opts.name}'. Must match ^[A-Z][A-Z0-9_]*$ (uppercase letters, digits, underscores; start with a letter).`,
    );
  }
  if (!opts.value) {
    throw new Error("Secret value must not be empty.");
  }
  const now = Date.now();
  const row = db
    .prepare(
      `INSERT INTO code_project_secrets
         (code_project_id, name, description, value, is_viewable, llm_forbidden, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
    )
    .get(
      opts.codeProjectId,
      opts.name,
      opts.description ?? "",
      opts.value,
      opts.isViewable ? 1 : 0,
      opts.llmForbidden ? 1 : 0,
      opts.createdBy ?? null,
      now,
      now,
    ) as SecretRow;
  return rowToSecret(row);
}

export interface UpdateSecretOpts {
  name?: string;
  description?: string;
  value?: string;
  isViewable?: boolean;
  llmForbidden?: boolean;
}

export function updateSecret(
  db: Database,
  id: number,
  patch: UpdateSecretOpts,
): CodeProjectSecret | undefined {
  if (patch.name !== undefined && !SECRET_NAME_RE.test(patch.name)) {
    throw new Error(
      `Invalid secret name '${patch.name}'. Must match ^[A-Z][A-Z0-9_]*$ (uppercase letters, digits, underscores; start with a letter).`,
    );
  }
  if (patch.value !== undefined && !patch.value) {
    throw new Error("Secret value must not be empty.");
  }

  const existing = getSecret(db, id);
  if (!existing) return undefined;

  const name = patch.name ?? existing.name;
  const description = patch.description ?? existing.description;
  const value = patch.value ?? existing.value;
  const isViewable =
    patch.isViewable !== undefined ? patch.isViewable : existing.isViewable;
  const llmForbidden =
    patch.llmForbidden !== undefined
      ? patch.llmForbidden
      : existing.llmForbidden;

  const row = db
    .prepare(
      `UPDATE code_project_secrets
       SET name = ?, description = ?, value = ?, is_viewable = ?, llm_forbidden = ?, updated_at = ?
       WHERE id = ?
       RETURNING *`,
    )
    .get(
      name,
      description,
      value,
      isViewable ? 1 : 0,
      llmForbidden ? 1 : 0,
      Date.now(),
      id,
    ) as SecretRow | undefined;
  return row ? rowToSecret(row) : undefined;
}

export function deleteSecret(db: Database, id: number): boolean {
  const result = db
    .prepare(`DELETE FROM code_project_secrets WHERE id = ?`)
    .run(id);
  return result.changes > 0;
}

export function markSecretsUsed(db: Database, ids: number[]): void {
  if (ids.length === 0) return;
  const now = Date.now();
  const placeholders = ids.map(() => "?").join(", ");
  db.prepare(
    `UPDATE code_project_secrets SET last_used_at = ? WHERE id IN (${placeholders})`,
  ).run(now, ...ids);
}

// ── Runtime helpers ───────────────────────────────────────────────────────────

export interface SubstituteResult {
  content: string;
  unknownTags: string[];
  usedSecretIds: number[];
}

/**
 * Replaces {{secret:NAME}} tags in `content` with the matching secret value.
 * Returns the substituted content, the list of unresolved tag names (if any),
 * and the ids of secrets that were actually used.
 * Does NOT mutate the DB.
 */
export function substituteSecrets(
  content: string,
  secrets: CodeProjectSecret[],
): SubstituteResult {
  const byName = new Map(secrets.map((s) => [s.name, s]));
  const unknownTags: string[] = [];
  const usedSecretIds: number[] = [];

  const resolved = content.replace(SECRET_TAG_RE, (_match, name: string) => {
    const secret = byName.get(name);
    if (!secret) {
      if (!unknownTags.includes(name)) unknownTags.push(name);
      return _match; // leave unchanged so the caller can report it
    }
    if (!usedSecretIds.includes(secret.id)) usedSecretIds.push(secret.id);
    return secret.value;
  });

  return { content: resolved, unknownTags, usedSecretIds };
}

/**
 * Returns a Record<name, value> suitable for spreading into process.env when
 * spawning a child process. Every secret is included regardless of whether it
 * is referenced via a tag — env-var access is opt-in from the script itself.
 */
export function secretsToEnv(
  secrets: CodeProjectSecret[],
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const s of secrets) {
    env[s.name] = s.value;
  }
  return env;
}

// ── LLM guard helper ─────────────────────────────────────────────────────────

/**
 * Returns all non-empty values that are marked llm_forbidden=1 across every
 * non-deleted code project. Used by the LLM guard in secret_guard.ts to scan
 * user-typed content before it reaches the LLM.
 */
export function loadForbiddenSecretValues(db: Database): string[] {
  const rows = db
    .prepare(
      `SELECT s.value
       FROM code_project_secrets s
       JOIN code_projects cp ON cp.id = s.code_project_id
       WHERE s.llm_forbidden = 1
         AND s.value != ''
         AND cp.deleted_at IS NULL`,
    )
    .all() as { value: string }[];
  return rows.map((r) => r.value);
}
