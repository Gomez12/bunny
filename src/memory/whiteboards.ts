import type { Database } from "bun:sqlite";
import type { Project } from "./projects.ts";
import type { User } from "../auth/users.ts";
import { registerTrashable, softDelete } from "./trash.ts";

registerTrashable({
  kind: "whiteboard",
  table: "whiteboards",
  nameColumn: "name",
  hasUniqueName: true,
  translationSidecarTable: null,
  translationSidecarFk: null,
});

export interface Whiteboard {
  id: number;
  project: string;
  name: string;
  elementsJson: string;
  appStateJson: string | null;
  thumbnail: string | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

export type WhiteboardSummary = Pick<
  Whiteboard,
  "id" | "name" | "thumbnail" | "createdAt" | "updatedAt"
>;

interface WhiteboardRow {
  id: number;
  project: string;
  name: string;
  elements_json: string;
  app_state_json: string | null;
  thumbnail: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

function rowToWhiteboard(r: WhiteboardRow): Whiteboard {
  return {
    id: r.id,
    project: r.project,
    name: r.name,
    elementsJson: r.elements_json,
    appStateJson: r.app_state_json,
    thumbnail: r.thumbnail,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const SELECT_COLS = `id, project, name, elements_json, app_state_json, thumbnail,
                     created_by, created_at, updated_at`;

const SUMMARY_COLS = `id, name, thumbnail, created_at, updated_at`;

export function listWhiteboards(
  db: Database,
  project: string,
): WhiteboardSummary[] {
  const rows = db
    .prepare(
      `SELECT ${SUMMARY_COLS} FROM whiteboards
       WHERE project = ? AND deleted_at IS NULL
       ORDER BY updated_at DESC`,
    )
    .all(project) as Pick<
    WhiteboardRow,
    "id" | "name" | "thumbnail" | "created_at" | "updated_at"
  >[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    thumbnail: r.thumbnail,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export function getWhiteboard(db: Database, id: number): Whiteboard | null {
  const row = db
    .prepare(
      `SELECT ${SELECT_COLS} FROM whiteboards WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(id) as WhiteboardRow | undefined;
  return row ? rowToWhiteboard(row) : null;
}

export interface CreateWhiteboardOpts {
  project: string;
  name: string;
  elementsJson?: string;
  appStateJson?: string;
  thumbnail?: string;
  createdBy: string;
}

export function createWhiteboard(
  db: Database,
  opts: CreateWhiteboardOpts,
): Whiteboard {
  const name = opts.name.trim();
  if (!name) throw new Error("whiteboard name is required");
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO whiteboards(project, name, elements_json, app_state_json, thumbnail,
                               created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.project,
      name,
      opts.elementsJson ?? "[]",
      opts.appStateJson ?? null,
      opts.thumbnail ?? null,
      opts.createdBy,
      now,
      now,
    );
  return getWhiteboard(db, Number(info.lastInsertRowid))!;
}

export interface UpdateWhiteboardPatch {
  name?: string;
  elementsJson?: string;
  appStateJson?: string | null;
  thumbnail?: string | null;
}

export function updateWhiteboard(
  db: Database,
  id: number,
  patch: UpdateWhiteboardPatch,
): Whiteboard {
  const existing = getWhiteboard(db, id);
  if (!existing) throw new Error(`whiteboard ${id} not found`);

  const name = patch.name === undefined ? existing.name : patch.name.trim();
  if (!name) throw new Error("whiteboard name is required");
  const elementsJson = patch.elementsJson ?? existing.elementsJson;
  const appStateJson =
    patch.appStateJson === undefined
      ? existing.appStateJson
      : patch.appStateJson;
  const thumbnail =
    patch.thumbnail === undefined ? existing.thumbnail : patch.thumbnail;

  db.prepare(
    `UPDATE whiteboards
     SET name = ?, elements_json = ?, app_state_json = ?, thumbnail = ?, updated_at = ?
     WHERE id = ?`,
  ).run(name, elementsJson, appStateJson, thumbnail, Date.now(), id);
  return getWhiteboard(db, id)!;
}

export function deleteWhiteboard(
  db: Database,
  id: number,
  deletedBy: string | null = null,
): void {
  softDelete(db, "whiteboard", id, deletedBy);
}

export function canEditWhiteboard(
  user: User,
  wb: Whiteboard,
  project: Project,
): boolean {
  if (user.role === "admin") return true;
  if (project.createdBy && project.createdBy === user.id) return true;
  if (wb.createdBy === user.id) return true;
  return false;
}
