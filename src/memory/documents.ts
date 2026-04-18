import type { Database } from "bun:sqlite";
import type { Project } from "./projects.ts";
import type { User } from "../auth/users.ts";

export interface Document {
  id: number;
  project: string;
  name: string;
  contentMd: string;
  thumbnail: string | null;
  isTemplate: boolean;
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
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const SELECT_COLS = `id, project, name, content_md, thumbnail, is_template,
                     created_by, created_at, updated_at`;

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
      ? `SELECT ${SUMMARY_COLS} FROM documents WHERE project = ? AND is_template = ? ORDER BY updated_at DESC`
      : `SELECT ${SUMMARY_COLS} FROM documents WHERE project = ? AND is_template = 0 ORDER BY updated_at DESC`;
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
    .prepare(`SELECT ${SELECT_COLS} FROM documents WHERE id = ?`)
    .get(id) as DocumentRow | undefined;
  return row ? rowToDocument(row) : null;
}

export interface CreateDocumentOpts {
  project: string;
  name: string;
  contentMd?: string;
  thumbnail?: string;
  isTemplate?: boolean;
  createdBy: string;
}

export function createDocument(
  db: Database,
  opts: CreateDocumentOpts,
): Document {
  const name = opts.name.trim();
  if (!name) throw new Error("document name is required");
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO documents(project, name, content_md, thumbnail, is_template,
                             created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.project,
      name,
      opts.contentMd ?? "",
      opts.thumbnail ?? null,
      opts.isTemplate ? 1 : 0,
      opts.createdBy,
      now,
      now,
    );
  return getDocument(db, Number(info.lastInsertRowid))!;
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
  return getDocument(db, id)!;
}

export function deleteDocument(db: Database, id: number): void {
  db.prepare(`DELETE FROM documents WHERE id = ?`).run(id);
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
      .prepare(`SELECT id FROM documents WHERE project = ? AND name = ?`)
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
