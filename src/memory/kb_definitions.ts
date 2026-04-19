/**
 * Knowledge Base — Definitions.
 *
 * Per-project dictionary of project-specific terms. Each row carries up to
 * three candidate descriptions (manual, short LLM, long LLM) plus a list of
 * external source links. The `active_description` column names the one the
 * project considers authoritative. See ADR 0021.
 */

import type { Database } from "bun:sqlite";
import type { User } from "../auth/users.ts";
import type { Project } from "./projects.ts";
import {
  createTranslationSlots,
  markAllStale as markTranslationsStale,
  registerKind,
  type TranslatableKind,
} from "./translatable.ts";
import { registerTrashable, softDelete } from "./trash.ts";

export const KB_DEFINITION_KIND: TranslatableKind = {
  name: "kb_definition",
  entityTable: "kb_definitions",
  sidecarTable: "kb_definition_translations",
  entityFk: "definition_id",
  sourceFields: ["term", "manual_description", "llm_short", "llm_long"],
  sidecarFields: ["term", "manual_description", "llm_short", "llm_long"],
  aliveFilter: "deleted_at IS NULL",
};
registerKind(KB_DEFINITION_KIND);

registerTrashable({
  kind: "kb_definition",
  table: "kb_definitions",
  nameColumn: "term",
  hasUniqueName: true,
  translationSidecarTable: "kb_definition_translations",
  translationSidecarFk: "definition_id",
});

export type ActiveDescription = "manual" | "short" | "long";
export type LlmStatus = "idle" | "generating" | "error";
export type SvgStatus = "idle" | "generating" | "error";

export interface DefinitionSource {
  title: string;
  url: string;
}

export interface Definition {
  id: number;
  project: string;
  term: string;
  manualDescription: string;
  llmShort: string | null;
  llmLong: string | null;
  llmSources: DefinitionSource[];
  llmCleared: boolean;
  llmStatus: LlmStatus;
  llmError: string | null;
  llmGeneratedAt: number | null;
  isProjectDependent: boolean;
  activeDescription: ActiveDescription;
  originalLang: string | null;
  svgContent: string | null;
  svgStatus: SvgStatus;
  svgError: string | null;
  svgGeneratedAt: number | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

interface DefinitionRow {
  id: number;
  project: string;
  term: string;
  manual_description: string;
  llm_short: string | null;
  llm_long: string | null;
  llm_sources: string;
  llm_cleared: number;
  llm_status: string;
  llm_error: string | null;
  llm_generated_at: number | null;
  is_project_dependent: number;
  active_description: string;
  original_lang: string | null;
  svg_content: string | null;
  svg_status: string;
  svg_error: string | null;
  svg_generated_at: number | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

const SELECT_COLS = `id, project, term, manual_description, llm_short, llm_long,
                     llm_sources, llm_cleared, llm_status, llm_error,
                     llm_generated_at, is_project_dependent, active_description,
                     original_lang, svg_content, svg_status, svg_error,
                     svg_generated_at, created_by, created_at, updated_at`;

function parseSources(raw: string): DefinitionSource[] {
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    const out: DefinitionSource[] = [];
    for (const s of arr) {
      if (
        s &&
        typeof s === "object" &&
        typeof s.title === "string" &&
        typeof s.url === "string"
      ) {
        out.push({ title: s.title, url: s.url });
      }
    }
    return out;
  } catch {
    return [];
  }
}

function normaliseStatus(raw: string): LlmStatus {
  return raw === "generating" || raw === "error" ? raw : "idle";
}

function normaliseSvgStatus(raw: string): SvgStatus {
  return raw === "generating" || raw === "error" ? raw : "idle";
}

function normaliseActive(raw: string): ActiveDescription {
  return raw === "short" || raw === "long" ? raw : "manual";
}

function rowToDefinition(r: DefinitionRow): Definition {
  return {
    id: r.id,
    project: r.project,
    term: r.term,
    manualDescription: r.manual_description,
    llmShort: r.llm_short,
    llmLong: r.llm_long,
    llmSources: parseSources(r.llm_sources),
    llmCleared: r.llm_cleared !== 0,
    llmStatus: normaliseStatus(r.llm_status),
    llmError: r.llm_error,
    llmGeneratedAt: r.llm_generated_at,
    isProjectDependent: r.is_project_dependent !== 0,
    activeDescription: normaliseActive(r.active_description),
    originalLang: r.original_lang,
    svgContent: r.svg_content,
    svgStatus: normaliseSvgStatus(r.svg_status),
    svgError: r.svg_error,
    svgGeneratedAt: r.svg_generated_at,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ── Listing / reading ────────────────────────────────────────────────────────

export interface ListDefinitionsOpts {
  search?: string;
  limit?: number;
  offset?: number;
}

export function listDefinitions(
  db: Database,
  project: string,
  opts?: ListDefinitionsOpts,
): { definitions: Definition[]; total: number } {
  const conditions = ["project = ?", "deleted_at IS NULL"];
  const params: (string | number)[] = [project];

  if (opts?.search) {
    const q = `%${opts.search}%`;
    conditions.push(
      "(term LIKE ? OR manual_description LIKE ? OR llm_short LIKE ? OR llm_long LIKE ?)",
    );
    params.push(q, q, q, q);
  }

  const where = conditions.join(" AND ");
  const countParams = [...params];

  let sql = `SELECT ${SELECT_COLS} FROM kb_definitions WHERE ${where} ORDER BY term ASC`;
  if (opts?.limit !== undefined) {
    sql += ` LIMIT ?`;
    params.push(opts.limit);
    if (opts?.offset !== undefined) {
      sql += ` OFFSET ?`;
      params.push(opts.offset);
    }
  }

  const rows = db.prepare(sql).all(...params) as DefinitionRow[];
  const countRow = db
    .prepare(`SELECT COUNT(*) AS cnt FROM kb_definitions WHERE ${where}`)
    .get(...countParams) as { cnt: number };
  return { definitions: rows.map(rowToDefinition), total: countRow.cnt };
}

export function getDefinition(db: Database, id: number): Definition | null {
  const row = db
    .prepare(
      `SELECT ${SELECT_COLS} FROM kb_definitions WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(id) as DefinitionRow | undefined;
  return row ? rowToDefinition(row) : null;
}

export function getDefinitionByTerm(
  db: Database,
  project: string,
  term: string,
): Definition | null {
  const row = db
    .prepare(
      `SELECT ${SELECT_COLS} FROM kb_definitions
        WHERE project = ? AND term = ? AND deleted_at IS NULL`,
    )
    .get(project, term) as DefinitionRow | undefined;
  return row ? rowToDefinition(row) : null;
}

// ── Create / update / delete ─────────────────────────────────────────────────

export interface CreateDefinitionOpts {
  project: string;
  term: string;
  manualDescription?: string;
  isProjectDependent?: boolean;
  activeDescription?: ActiveDescription;
  originalLang?: string;
  createdBy: string;
}

function resolveOriginalLang(
  db: Database,
  project: string,
  explicit: string | undefined,
): string | null {
  if (explicit) return explicit;
  const row = db
    .prepare(`SELECT default_language FROM projects WHERE name = ?`)
    .get(project) as { default_language: string } | undefined;
  return row?.default_language ?? null;
}

function validateActiveDescription(
  raw: ActiveDescription | undefined,
): ActiveDescription {
  if (raw === undefined) return "manual";
  if (raw === "manual" || raw === "short" || raw === "long") return raw;
  throw new Error(`invalid active_description '${raw}'`);
}

export function createDefinition(
  db: Database,
  opts: CreateDefinitionOpts,
): Definition {
  const term = opts.term.trim();
  if (!term) throw new Error("definition term is required");
  const active = validateActiveDescription(opts.activeDescription);
  const now = Date.now();

  const originalLang = resolveOriginalLang(db, opts.project, opts.originalLang);
  const info = db
    .prepare(
      `INSERT INTO kb_definitions(
         project, term, manual_description,
         llm_short, llm_long, llm_sources, llm_cleared, llm_status, llm_error,
         llm_generated_at, is_project_dependent, active_description,
         original_lang, created_by, created_at, updated_at
       ) VALUES (?, ?, ?, NULL, NULL, '[]', 0, 'idle', NULL, NULL, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.project,
      term,
      opts.manualDescription ?? "",
      opts.isProjectDependent ? 1 : 0,
      active,
      originalLang,
      opts.createdBy,
      now,
      now,
    );
  const id = Number(info.lastInsertRowid);
  createTranslationSlots(db, KB_DEFINITION_KIND, id);
  return getDefinition(db, id)!;
}

export interface UpdateDefinitionPatch {
  term?: string;
  manualDescription?: string;
  isProjectDependent?: boolean;
  activeDescription?: ActiveDescription;
}

export function updateDefinition(
  db: Database,
  id: number,
  patch: UpdateDefinitionPatch,
): Definition {
  const existing = getDefinition(db, id);
  if (!existing) throw new Error(`definition ${id} not found`);

  const term = patch.term === undefined ? existing.term : patch.term.trim();
  if (!term) throw new Error("definition term is required");

  const manualDescription =
    patch.manualDescription === undefined
      ? existing.manualDescription
      : patch.manualDescription;
  const isProjectDependent =
    patch.isProjectDependent === undefined
      ? existing.isProjectDependent
      : patch.isProjectDependent;
  const activeDescription =
    patch.activeDescription === undefined
      ? existing.activeDescription
      : validateActiveDescription(patch.activeDescription);

  db.prepare(
    `UPDATE kb_definitions
     SET term = ?, manual_description = ?, is_project_dependent = ?,
         active_description = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    term,
    manualDescription,
    isProjectDependent ? 1 : 0,
    activeDescription,
    Date.now(),
    id,
  );

  const sourceChanged =
    term !== existing.term || manualDescription !== existing.manualDescription;
  if (sourceChanged) markTranslationsStale(db, KB_DEFINITION_KIND, id);

  return getDefinition(db, id)!;
}

export function deleteDefinition(
  db: Database,
  id: number,
  deletedBy: string | null = null,
): void {
  softDelete(db, "kb_definition", id, deletedBy);
}

// ── LLM field state machine ─────────────────────────────────────────────────

/**
 * Conditionally flip `llm_status` to `'generating'`. Returns true when this
 * caller won the race (status was not already `'generating'`). Callers that
 * lose the race should surface a 409 so two concurrent Generate clicks do not
 * double-bill the LLM.
 */
export function setLlmGenerating(db: Database, id: number): boolean {
  const info = db
    .prepare(
      `UPDATE kb_definitions
       SET llm_status = 'generating', llm_error = NULL, updated_at = ?
       WHERE id = ? AND llm_status != 'generating'`,
    )
    .run(Date.now(), id);
  return info.changes > 0;
}

export function setLlmResult(
  db: Database,
  id: number,
  result: { short: string; long: string; sources: DefinitionSource[] },
): Definition {
  const now = Date.now();
  db.prepare(
    `UPDATE kb_definitions
     SET llm_short = ?, llm_long = ?, llm_sources = ?,
         llm_cleared = 0, llm_status = 'idle', llm_error = NULL,
         llm_generated_at = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    result.short,
    result.long,
    JSON.stringify(result.sources),
    now,
    now,
    id,
  );
  // llm_short + llm_long are source fields for the translation layer —
  // regenerating them invalidates all translations.
  markTranslationsStale(db, KB_DEFINITION_KIND, id);
  const updated = getDefinition(db, id);
  if (!updated)
    throw new Error(`definition ${id} vanished during setLlmResult`);
  return updated;
}

export function setLlmError(
  db: Database,
  id: number,
  error: string,
): Definition {
  db.prepare(
    `UPDATE kb_definitions
     SET llm_status = 'error', llm_error = ?, updated_at = ?
     WHERE id = ?`,
  ).run(error, Date.now(), id);
  const updated = getDefinition(db, id);
  if (!updated) throw new Error(`definition ${id} vanished during setLlmError`);
  return updated;
}

/**
 * Clear the three LLM fields and mark the row as explicitly cleared. Also
 * resets `active_description` to `'manual'` so downstream consumers never
 * point at an empty slot.
 */
export function clearLlmFields(db: Database, id: number): Definition {
  db.prepare(
    `UPDATE kb_definitions
     SET llm_short = NULL, llm_long = NULL, llm_sources = '[]',
         llm_cleared = 1, llm_status = 'idle', llm_error = NULL,
         llm_generated_at = NULL, active_description = 'manual',
         updated_at = ?
     WHERE id = ?`,
  ).run(Date.now(), id);
  // The LLM source fields were cleared — translations must re-derive too.
  markTranslationsStale(db, KB_DEFINITION_KIND, id);
  const updated = getDefinition(db, id);
  if (!updated) throw new Error(`definition ${id} not found`);
  return updated;
}

// ── SVG illustration state machine ──────────────────────────────────────────

/**
 * Conditional flip of `svg_status` to `'generating'`. Returns true when this
 * caller won the race. Matches the `setLlmGenerating` pattern so two concurrent
 * Generate-illustration clicks never double-bill the model.
 */
export function setSvgGenerating(db: Database, id: number): boolean {
  const info = db
    .prepare(
      `UPDATE kb_definitions
       SET svg_status = 'generating', svg_error = NULL, updated_at = ?
       WHERE id = ? AND svg_status != 'generating'`,
    )
    .run(Date.now(), id);
  return info.changes > 0;
}

export function setSvgResult(
  db: Database,
  id: number,
  svg: string,
): Definition {
  const now = Date.now();
  db.prepare(
    `UPDATE kb_definitions
     SET svg_content = ?, svg_status = 'idle', svg_error = NULL,
         svg_generated_at = ?, updated_at = ?
     WHERE id = ?`,
  ).run(svg, now, now, id);
  const updated = getDefinition(db, id);
  if (!updated)
    throw new Error(`definition ${id} vanished during setSvgResult`);
  return updated;
}

export function setSvgError(
  db: Database,
  id: number,
  error: string,
): Definition {
  db.prepare(
    `UPDATE kb_definitions
     SET svg_status = 'error', svg_error = ?, updated_at = ?
     WHERE id = ?`,
  ).run(error, Date.now(), id);
  const updated = getDefinition(db, id);
  if (!updated) throw new Error(`definition ${id} vanished during setSvgError`);
  return updated;
}

/**
 * Clear the stored SVG and reset the illustration state. Mirrors
 * `clearLlmFields` but only touches the `svg_*` column set.
 */
export function clearSvgFields(db: Database, id: number): Definition {
  db.prepare(
    `UPDATE kb_definitions
     SET svg_content = NULL, svg_status = 'idle', svg_error = NULL,
         svg_generated_at = NULL, updated_at = ?
     WHERE id = ?`,
  ).run(Date.now(), id);
  const updated = getDefinition(db, id);
  if (!updated) throw new Error(`definition ${id} not found`);
  return updated;
}

export function setActiveDescription(
  db: Database,
  id: number,
  kind: ActiveDescription,
): Definition {
  if (kind !== "manual" && kind !== "short" && kind !== "long") {
    throw new Error(`invalid active_description '${kind}'`);
  }
  db.prepare(
    `UPDATE kb_definitions SET active_description = ?, updated_at = ? WHERE id = ?`,
  ).run(kind, Date.now(), id);
  const updated = getDefinition(db, id);
  if (!updated) throw new Error(`definition ${id} not found`);
  return updated;
}

// ── Permissions ──────────────────────────────────────────────────────────────

export function canEditDefinition(
  user: User,
  def: Definition,
  project: Project,
): boolean {
  if (user.role === "admin") return true;
  if (project.createdBy && project.createdBy === user.id) return true;
  if (def.createdBy === user.id) return true;
  return false;
}
