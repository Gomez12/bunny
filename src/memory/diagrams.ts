import type { Database } from "bun:sqlite";
import type { Project } from "./projects.ts";
import type { User } from "../auth/users.ts";
import { registerTrashable, softDelete } from "./trash.ts";
import { registerVersionable } from "./versioning.ts";
import { projectScopedAccess } from "./versioning_access.ts";

registerTrashable({
  kind: "diagram",
  table: "diagrams",
  nameColumn: "name",
  hasUniqueName: true,
  translationSidecarTable: null,
  translationSidecarFk: null,
});

// Pure DB row — no on-disk sidecar. `diagram_type` is part of the snapshot
// because diagrams can be retyped (architecture → flowchart etc.) and the
// node-library compatibility depends on it.
registerVersionable({
  kind: "diagram",
  table: "diagrams",
  primaryKey: "id",
  snapshot(db, id) {
    const row = db
      .prepare(
        `SELECT id, project, name, diagram_type, description, content_json,
                thumbnail, created_by, created_at, updated_at
           FROM diagrams WHERE id = ?`,
      )
      .get(Number(id)) as Record<string, unknown> | undefined;
    return row ? { ...row } : null;
  },
  restore(db, id, snapshot) {
    db.prepare(
      `UPDATE diagrams
          SET name = ?, diagram_type = ?, description = ?, content_json = ?,
              thumbnail = ?, updated_at = ?
        WHERE id = ?`,
    ).run(
      String(snapshot["name"] ?? ""),
      String(snapshot["diagram_type"] ?? "custom"),
      String(snapshot["description"] ?? ""),
      String(snapshot["content_json"] ?? '{"nodes":[],"edges":[]}'),
      (snapshot["thumbnail"] as string | null) ?? null,
      Date.now(),
      Number(id),
    );
  },
  canSee: (db, userId, id) =>
    projectScopedAccess(db, userId, "diagrams", "id", id, "see"),
  canEdit: (db, userId, id) =>
    projectScopedAccess(db, userId, "diagrams", "id", id, "edit"),
});

export interface Diagram {
  id: number;
  project: string;
  name: string;
  diagramType: string;
  description: string;
  contentJson: string;
  thumbnail: string | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

export type DiagramSummary = Pick<
  Diagram,
  "id" | "name" | "diagramType" | "thumbnail" | "createdAt" | "updatedAt"
>;

interface DiagramRow {
  id: number;
  project: string;
  name: string;
  diagram_type: string;
  description: string;
  content_json: string;
  thumbnail: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

function rowToDiagram(r: DiagramRow): Diagram {
  return {
    id: r.id,
    project: r.project,
    name: r.name,
    diagramType: r.diagram_type,
    description: r.description,
    contentJson: r.content_json,
    thumbnail: r.thumbnail,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const SELECT_COLS = `id, project, name, diagram_type, description, content_json,
                     thumbnail, created_by, created_at, updated_at`;

const SUMMARY_COLS = `id, name, diagram_type, thumbnail, created_at, updated_at`;

export function listDiagrams(db: Database, project: string): DiagramSummary[] {
  const rows = db
    .prepare(
      `SELECT ${SUMMARY_COLS} FROM diagrams
       WHERE project = ? AND deleted_at IS NULL
       ORDER BY updated_at DESC`,
    )
    .all(project) as Pick<
    DiagramRow,
    "id" | "name" | "diagram_type" | "thumbnail" | "created_at" | "updated_at"
  >[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    diagramType: r.diagram_type,
    thumbnail: r.thumbnail,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export function getDiagram(db: Database, id: number): Diagram | null {
  const row = db
    .prepare(
      `SELECT ${SELECT_COLS} FROM diagrams WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(id) as DiagramRow | undefined;
  return row ? rowToDiagram(row) : null;
}

export interface CreateDiagramOpts {
  project: string;
  name: string;
  diagramType?: string;
  description?: string;
  contentJson?: string;
  createdBy: string;
}

export function createDiagram(db: Database, opts: CreateDiagramOpts): Diagram {
  const name = opts.name.trim();
  if (!name) throw new Error("diagram name is required");
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO diagrams(project, name, diagram_type, description, content_json,
                            thumbnail, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    )
    .run(
      opts.project,
      name,
      opts.diagramType ?? "custom",
      opts.description ?? "",
      opts.contentJson ?? '{"nodes":[],"edges":[]}',
      opts.createdBy,
      now,
      now,
    );
  return getDiagram(db, Number(info.lastInsertRowid))!;
}

export interface UpdateDiagramPatch {
  name?: string;
  description?: string;
  contentJson?: string;
  thumbnail?: string | null;
}

export function updateDiagram(
  db: Database,
  id: number,
  patch: UpdateDiagramPatch,
): Diagram {
  const existing = getDiagram(db, id);
  if (!existing) throw new Error(`diagram ${id} not found`);

  const name = patch.name === undefined ? existing.name : patch.name.trim();
  if (!name) throw new Error("diagram name is required");
  const description =
    patch.description === undefined ? existing.description : patch.description;
  const contentJson = patch.contentJson ?? existing.contentJson;
  const thumbnail =
    patch.thumbnail === undefined ? existing.thumbnail : patch.thumbnail;

  db.prepare(
    `UPDATE diagrams
     SET name = ?, description = ?, content_json = ?, thumbnail = ?, updated_at = ?
     WHERE id = ?`,
  ).run(name, description, contentJson, thumbnail, Date.now(), id);
  return getDiagram(db, id)!;
}

export function deleteDiagram(
  db: Database,
  id: number,
  deletedBy: string | null = null,
): void {
  softDelete(db, "diagram", id, deletedBy);
}

export function canEditDiagram(
  user: User,
  diagram: Diagram,
  project: Project,
): boolean {
  if (user.role === "admin") return true;
  if (project.createdBy && project.createdBy === user.id) return true;
  if (diagram.createdBy === user.id) return true;
  return false;
}
