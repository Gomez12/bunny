import type { Database } from "bun:sqlite";
import type { Project } from "./projects.ts";
import type { User } from "../auth/users.ts";
import {
  createTranslationSlots,
  markAllStale as markTranslationsStale,
  registerKind,
  type TranslatableKind,
} from "./translatable.ts";
import { registerTrashable, softDelete } from "./trash.ts";

export const DOCUMENT_KIND: TranslatableKind = {
  name: "document",
  entityTable: "documents",
  sidecarTable: "document_translations",
  entityFk: "document_id",
  sourceFields: ["name", "content_md"],
  sidecarFields: ["name", "content_md"],
  aliveFilter: "deleted_at IS NULL",
};
registerKind(DOCUMENT_KIND);

registerTrashable({
  kind: "document",
  table: "documents",
  nameColumn: "name",
  hasUniqueName: true,
  translationSidecarTable: "document_translations",
  translationSidecarFk: "document_id",
});

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

export interface Document {
  id: number;
  project: string;
  name: string;
  contentMd: string;
  thumbnail: string | null;
  isTemplate: boolean;
  originalLang: string | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

export type DocumentSummary = Pick<
  Document,
  "id" | "name" | "thumbnail" | "isTemplate" | "createdAt" | "updatedAt"
>;

interface DocumentRow {
  id: number;
  project: string;
  name: string;
  content_md: string;
  thumbnail: string | null;
  is_template: number;
  original_lang: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

function rowToDocument(r: DocumentRow): Document {
  return {
    id: r.id,
    project: r.project,
    name: r.name,
    contentMd: r.content_md,
    thumbnail: r.thumbnail,
    isTemplate: r.is_template === 1,
    originalLang: r.original_lang,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const SELECT_COLS = `id, project, name, content_md, thumbnail, is_template,
                     original_lang, created_by, created_at, updated_at`;

const SUMMARY_COLS = `id, name, thumbnail, is_template, created_at, updated_at`;

export function listDocuments(
  db: Database,
  project: string,
  opts?: { isTemplate?: boolean },
): DocumentSummary[] {
  const templateFilter =
    opts?.isTemplate !== undefined ? (opts.isTemplate ? 1 : 0) : undefined;
  const sql =
    templateFilter !== undefined
      ? `SELECT ${SUMMARY_COLS} FROM documents WHERE project = ? AND is_template = ? AND deleted_at IS NULL ORDER BY updated_at DESC`
      : `SELECT ${SUMMARY_COLS} FROM documents WHERE project = ? AND is_template = 0 AND deleted_at IS NULL ORDER BY updated_at DESC`;
  const params =
    templateFilter !== undefined ? [project, templateFilter] : [project];
  const rows = db.prepare(sql).all(...params) as Pick<
    DocumentRow,
    "id" | "name" | "thumbnail" | "is_template" | "created_at" | "updated_at"
  >[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    thumbnail: r.thumbnail,
    isTemplate: r.is_template === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export function getDocument(db: Database, id: number): Document | null {
  const row = db
    .prepare(
      `SELECT ${SELECT_COLS} FROM documents WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(id) as DocumentRow | undefined;
  return row ? rowToDocument(row) : null;
}

export interface CreateDocumentOpts {
  project: string;
  name: string;
  contentMd?: string;
  thumbnail?: string;
  isTemplate?: boolean;
  originalLang?: string;
  createdBy: string;
}

export function createDocument(
  db: Database,
  opts: CreateDocumentOpts,
): Document {
  const name = opts.name.trim();
  if (!name) throw new Error("document name is required");
  const now = Date.now();
  const originalLang = resolveOriginalLang(db, opts.project, opts.originalLang);
  const info = db
    .prepare(
      `INSERT INTO documents(project, name, content_md, thumbnail, is_template,
                             original_lang, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.project,
      name,
      opts.contentMd ?? "",
      opts.thumbnail ?? null,
      opts.isTemplate ? 1 : 0,
      originalLang,
      opts.createdBy,
      now,
      now,
    );
  const id = Number(info.lastInsertRowid);
  createTranslationSlots(db, DOCUMENT_KIND, id);
  return getDocument(db, id)!;
}

export interface UpdateDocumentPatch {
  name?: string;
  contentMd?: string;
  thumbnail?: string | null;
}

export function updateDocument(
  db: Database,
  id: number,
  patch: UpdateDocumentPatch,
): Document {
  const existing = getDocument(db, id);
  if (!existing) throw new Error(`document ${id} not found`);

  const name = patch.name === undefined ? existing.name : patch.name.trim();
  if (!name) throw new Error("document name is required");
  const contentMd = patch.contentMd ?? existing.contentMd;
  const thumbnail =
    patch.thumbnail === undefined ? existing.thumbnail : patch.thumbnail;

  db.prepare(
    `UPDATE documents
     SET name = ?, content_md = ?, thumbnail = ?, updated_at = ?
     WHERE id = ?`,
  ).run(name, contentMd, thumbnail, Date.now(), id);

  const sourceChanged =
    name !== existing.name || contentMd !== existing.contentMd;
  if (sourceChanged) markTranslationsStale(db, DOCUMENT_KIND, id);

  return getDocument(db, id)!;
}

export function deleteDocument(
  db: Database,
  id: number,
  deletedBy: string | null = null,
): void {
  softDelete(db, "document", id, deletedBy);
}

export function canEditDocument(
  user: User,
  doc: Document,
  project: Project,
): boolean {
  if (user.role === "admin") return true;
  if (project.createdBy && project.createdBy === user.id) return true;
  if (doc.createdBy === user.id) return true;
  return false;
}

export function saveAsTemplate(
  db: Database,
  docId: number,
  createdBy: string,
): Document {
  const source = getDocument(db, docId);
  if (!source) throw new Error(`document ${docId} not found`);
  const baseName = source.name.replace(/^\[Template\]\s*/, "");
  let name = `[Template] ${baseName}`;
  let suffix = 1;
  while (true) {
    const existing = db
      .prepare(
        `SELECT id FROM documents
          WHERE project = ? AND name = ? AND deleted_at IS NULL`,
      )
      .get(source.project, name) as { id: number } | undefined;
    if (!existing) break;
    suffix++;
    name = `[Template] ${baseName} (${suffix})`;
  }
  return createDocument(db, {
    project: source.project,
    name,
    contentMd: source.contentMd,
    isTemplate: true,
    createdBy,
  });
}
