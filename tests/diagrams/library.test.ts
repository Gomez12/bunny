import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/memory/db.ts";
import { createProject } from "../../src/memory/projects.ts";
import {
  createLibraryItem,
  deleteLibraryItem,
  ensureSeededLibrary,
  listLibraryForProject,
  type SeedNode,
} from "../../src/memory/diagram_node_library.ts";

let tmp: string;

const MINI_SEEDS: SeedNode[] = [
  { diagram_type: "network", name: "Router", description: "", shape: "rectangle", icon_name: "Router", color: "#3b82f6", width: 120, height: 60, handle_sides: ["top", "right", "bottom", "left"] },
  { diagram_type: "network", name: "Switch", description: "", shape: "rectangle", icon_name: "Network", color: "#2563eb", width: 120, height: 60, handle_sides: ["top", "right", "bottom", "left"] },
  { diagram_type: "custom", name: "Box", description: "", shape: "rectangle", icon_name: null, color: "#374151", width: 140, height: 60, handle_sides: ["top", "right", "bottom", "left"] },
];

async function setup() {
  tmp = mkdtempSync(join(tmpdir(), "bunny-diagram-lib-"));
  const db = await openDb(join(tmp, "test.sqlite"));
  const now = Date.now();
  db.run(
    `INSERT INTO users(id, username, password_hash, role, created_at, updated_at)
     VALUES ('owner', 'owner', 'x', 'admin', ?, ?)`,
    [now, now],
  );
  createProject(db, { name: "proj", createdBy: "owner" });
  return { db };
}

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("ensureSeededLibrary", () => {
  test("inserts seeded rows on first call", async () => {
    const { db } = await setup();
    ensureSeededLibrary(db, MINI_SEEDS);
    const rows = db.prepare("SELECT COUNT(*) as n FROM diagram_node_library WHERE is_seeded = 1").get() as { n: number };
    expect(rows.n).toBe(3);
    db.close();
  });

  test("is idempotent — does not duplicate on second call", async () => {
    const { db } = await setup();
    ensureSeededLibrary(db, MINI_SEEDS);
    ensureSeededLibrary(db, MINI_SEEDS);
    const rows = db.prepare("SELECT COUNT(*) as n FROM diagram_node_library WHERE is_seeded = 1").get() as { n: number };
    expect(rows.n).toBe(3);
    db.close();
  });
});

describe("listLibraryForProject", () => {
  test("returns seeded + project custom items", async () => {
    const { db } = await setup();
    ensureSeededLibrary(db, MINI_SEEDS);
    createLibraryItem(db, { project: "proj", diagramType: "network", name: "Printer", createdBy: "owner" });
    const items = listLibraryForProject(db, "proj");
    expect(items.length).toBe(4);
    db.close();
  });

  test("filters by diagramType when provided", async () => {
    const { db } = await setup();
    ensureSeededLibrary(db, MINI_SEEDS);
    const networkItems = listLibraryForProject(db, "proj", "network");
    expect(networkItems.every((i) => i.diagramType === "network")).toBe(true);
    expect(networkItems.length).toBe(2);
    db.close();
  });

  test("project custom items not visible in other projects", async () => {
    const { db } = await setup();
    ensureSeededLibrary(db, MINI_SEEDS);
    createProject(db, { name: "other", createdBy: "owner" });
    createLibraryItem(db, { project: "proj", diagramType: "network", name: "Printer", createdBy: "owner" });
    const otherItems = listLibraryForProject(db, "other");
    expect(otherItems.every((i) => i.isSeeded)).toBe(true);
    db.close();
  });
});

describe("createLibraryItem", () => {
  test("creates a custom library item", async () => {
    const { db } = await setup();
    const item = createLibraryItem(db, {
      project: "proj",
      diagramType: "network",
      name: "Printer",
      description: "A network printer",
      shape: "rectangle",
      iconName: "Printer",
      color: "#64748b",
      createdBy: "owner",
    });
    expect(item.id).toBeGreaterThan(0);
    expect(item.name).toBe("Printer");
    expect(item.isSeeded).toBe(false);
    expect(item.project).toBe("proj");
    expect(item.iconName).toBe("Printer");
    db.close();
  });

  test("defaults shape and color when not provided", async () => {
    const { db } = await setup();
    const item = createLibraryItem(db, {
      project: "proj",
      diagramType: "custom",
      name: "Thing",
      createdBy: "owner",
    });
    expect(item.shape).toBe("rectangle");
    expect(item.color).toBe("#6b7280");
    expect(item.handleSides).toEqual(["top", "right", "bottom", "left"]);
    db.close();
  });
});

describe("deleteLibraryItem", () => {
  test("deletes a custom library item", async () => {
    const { db } = await setup();
    const item = createLibraryItem(db, { project: "proj", diagramType: "network", name: "Printer", createdBy: "owner" });
    expect(deleteLibraryItem(db, item.id)).toBe(true);
    const items = listLibraryForProject(db, "proj");
    expect(items.find((i) => i.id === item.id)).toBeUndefined();
    db.close();
  });

  test("returns false for seeded items (cannot delete)", async () => {
    const { db } = await setup();
    ensureSeededLibrary(db, MINI_SEEDS);
    const seeded = (db.prepare("SELECT id FROM diagram_node_library WHERE is_seeded = 1 LIMIT 1").get() as { id: number });
    expect(deleteLibraryItem(db, seeded.id)).toBe(false);
    db.close();
  });

  test("returns false for non-existent item", async () => {
    const { db } = await setup();
    expect(deleteLibraryItem(db, 9999)).toBe(false);
    db.close();
  });
});
