import type { Database } from "bun:sqlite";

export interface DiagramLibraryItem {
  id: number;
  project: string | null;
  diagramType: string;
  name: string;
  description: string;
  shape: string;
  iconName: string | null;
  color: string;
  width: number;
  height: number;
  handleSides: string[];
  isSeeded: boolean;
  createdAt: number;
}

interface LibraryRow {
  id: number;
  project: string | null;
  diagram_type: string;
  name: string;
  description: string;
  shape: string;
  icon_name: string | null;
  color: string;
  width: number;
  height: number;
  handle_sides: string;
  is_seeded: number;
  created_at: number;
}

function rowToItem(r: LibraryRow): DiagramLibraryItem {
  return {
    id: r.id,
    project: r.project,
    diagramType: r.diagram_type,
    name: r.name,
    description: r.description,
    shape: r.shape,
    iconName: r.icon_name,
    color: r.color,
    width: r.width,
    height: r.height,
    handleSides: JSON.parse(r.handle_sides) as string[],
    isSeeded: r.is_seeded === 1,
    createdAt: r.created_at,
  };
}

export function listLibraryForProject(
  db: Database,
  project: string,
  diagramType?: string,
): DiagramLibraryItem[] {
  const rows = diagramType
    ? (db
        .prepare(
          `SELECT * FROM diagram_node_library
           WHERE (is_seeded = 1 OR project = ?)
             AND (project IS NULL OR project = ?)
             AND diagram_type = ?
           ORDER BY is_seeded DESC, diagram_type, name`,
        )
        .all(project, project, diagramType) as LibraryRow[])
    : (db
        .prepare(
          `SELECT * FROM diagram_node_library
           WHERE (is_seeded = 1 OR project = ?)
             AND (project IS NULL OR project = ?)
           ORDER BY is_seeded DESC, diagram_type, name`,
        )
        .all(project, project) as LibraryRow[]);
  return rows.map(rowToItem);
}

export function getLibraryItem(
  db: Database,
  id: number,
): DiagramLibraryItem | null {
  const row = db
    .prepare("SELECT * FROM diagram_node_library WHERE id = ?")
    .get(id) as LibraryRow | undefined;
  return row ? rowToItem(row) : null;
}

export interface CreateLibraryItemOpts {
  project: string;
  diagramType: string;
  name: string;
  description?: string;
  shape?: string;
  iconName?: string | null;
  color?: string;
  width?: number;
  height?: number;
  handleSides?: string[];
  createdBy: string;
}

export function createLibraryItem(
  db: Database,
  opts: CreateLibraryItemOpts,
): DiagramLibraryItem {
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO diagram_node_library
         (project, diagram_type, name, description, shape, icon_name, color,
          width, height, handle_sides, is_seeded, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    )
    .run(
      opts.project,
      opts.diagramType,
      opts.name.trim(),
      opts.description ?? "",
      opts.shape ?? "rectangle",
      opts.iconName ?? null,
      opts.color ?? "#6b7280",
      opts.width ?? 140,
      opts.height ?? 60,
      JSON.stringify(opts.handleSides ?? ["top", "right", "bottom", "left"]),
      opts.createdBy,
      now,
    );
  return getLibraryItem(db, Number(info.lastInsertRowid))!;
}

export function deleteLibraryItem(db: Database, id: number): boolean {
  const item = getLibraryItem(db, id);
  if (!item || item.isSeeded) return false;
  db.prepare(
    "DELETE FROM diagram_node_library WHERE id = ? AND is_seeded = 0",
  ).run(id);
  return true;
}

export interface SeedNode {
  diagram_type: string;
  name: string;
  description: string;
  shape: string;
  icon_name: string | null;
  color: string;
  width: number;
  height: number;
  handle_sides: string[];
}

export function ensureSeededLibrary(db: Database, seeds: SeedNode[]): void {
  const count = (
    db
      .prepare(
        "SELECT COUNT(*) as n FROM diagram_node_library WHERE is_seeded = 1",
      )
      .get() as { n: number }
  ).n;
  if (count > 0) return;
  const now = Date.now();
  const stmt = db.prepare(
    `INSERT INTO diagram_node_library
       (project, diagram_type, name, description, shape, icon_name, color,
        width, height, handle_sides, is_seeded, created_by, created_at)
     VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?)`,
  );
  for (const s of seeds) {
    stmt.run(
      s.diagram_type,
      s.name,
      s.description,
      s.shape,
      s.icon_name,
      s.color,
      s.width,
      s.height,
      JSON.stringify(s.handle_sides),
      now,
    );
  }
}
