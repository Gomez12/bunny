import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/memory/db.ts";
import { createProject } from "../../src/memory/projects.ts";
import {
  canEditWhiteboard,
  createWhiteboard,
  deleteWhiteboard,
  getWhiteboard,
  listWhiteboards,
  updateWhiteboard,
} from "../../src/memory/whiteboards.ts";
import type { User } from "../../src/auth/users.ts";

let tmp: string;

async function newDb() {
  tmp = mkdtempSync(join(tmpdir(), "bunny-whiteboards-"));
  return openDb(join(tmp, "test.sqlite"));
}

async function setup() {
  const db = await newDb();
  const now = Date.now();
  db.run(
    `INSERT INTO users(id, username, password_hash, role, created_at, updated_at)
     VALUES ('owner', 'owner', 'x', 'admin', ?, ?)`,
    [now, now],
  );
  db.run(
    `INSERT INTO users(id, username, password_hash, role, created_at, updated_at)
     VALUES ('other', 'other', 'x', 'user', ?, ?)`,
    [now, now],
  );
  createProject(db, { name: "alpha", createdBy: "owner" });
  createProject(db, { name: "beta", createdBy: "owner" });
  return { db };
}

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("createWhiteboard", () => {
  test("creates a whiteboard with defaults", async () => {
    const { db } = await setup();
    const wb = createWhiteboard(db, { project: "alpha", name: "Design", createdBy: "owner" });
    expect(wb.id).toBeGreaterThan(0);
    expect(wb.project).toBe("alpha");
    expect(wb.name).toBe("Design");
    expect(wb.elementsJson).toBe("[]");
    expect(wb.thumbnail).toBeNull();
    expect(wb.createdBy).toBe("owner");
    db.close();
  });

  test("requires non-empty name", async () => {
    const { db } = await setup();
    expect(() =>
      createWhiteboard(db, { project: "alpha", name: "  ", createdBy: "owner" }),
    ).toThrow("whiteboard name is required");
    db.close();
  });

  test("enforces unique (project, name)", async () => {
    const { db } = await setup();
    createWhiteboard(db, { project: "alpha", name: "Design", createdBy: "owner" });
    expect(() =>
      createWhiteboard(db, { project: "alpha", name: "Design", createdBy: "owner" }),
    ).toThrow();
    db.close();
  });

  test("allows same name in different projects", async () => {
    const { db } = await setup();
    const a = createWhiteboard(db, { project: "alpha", name: "Design", createdBy: "owner" });
    const b = createWhiteboard(db, { project: "beta", name: "Design", createdBy: "owner" });
    expect(a.id).not.toBe(b.id);
    db.close();
  });
});

describe("listWhiteboards", () => {
  test("returns summaries scoped to project", async () => {
    const { db } = await setup();
    createWhiteboard(db, { project: "alpha", name: "A", createdBy: "owner" });
    createWhiteboard(db, { project: "alpha", name: "B", createdBy: "owner" });
    createWhiteboard(db, { project: "beta", name: "C", createdBy: "owner" });
    const list = listWhiteboards(db, "alpha");
    expect(list).toHaveLength(2);
    expect(list.map((w) => w.name).sort()).toEqual(["A", "B"]);
    expect(list[0]).not.toHaveProperty("elementsJson");
    db.close();
  });

  test("returns empty for project with no whiteboards", async () => {
    const { db } = await setup();
    expect(listWhiteboards(db, "alpha")).toHaveLength(0);
    db.close();
  });
});

describe("getWhiteboard", () => {
  test("returns full whiteboard with elements", async () => {
    const { db } = await setup();
    const created = createWhiteboard(db, {
      project: "alpha",
      name: "X",
      elementsJson: '[{"id":"1","type":"rectangle"}]',
      createdBy: "owner",
    });
    const wb = getWhiteboard(db, created.id);
    expect(wb).not.toBeNull();
    expect(wb!.elementsJson).toBe('[{"id":"1","type":"rectangle"}]');
    db.close();
  });

  test("returns null for missing id", async () => {
    const { db } = await setup();
    expect(getWhiteboard(db, 999)).toBeNull();
    db.close();
  });
});

describe("updateWhiteboard", () => {
  test("partial update preserves unchanged fields", async () => {
    const { db } = await setup();
    const wb = createWhiteboard(db, { project: "alpha", name: "Orig", createdBy: "owner" });
    const updated = updateWhiteboard(db, wb.id, { name: "Renamed" });
    expect(updated.name).toBe("Renamed");
    expect(updated.elementsJson).toBe("[]");
    db.close();
  });

  test("updates elements and thumbnail", async () => {
    const { db } = await setup();
    const wb = createWhiteboard(db, { project: "alpha", name: "X", createdBy: "owner" });
    const updated = updateWhiteboard(db, wb.id, {
      elementsJson: '[{"id":"1"}]',
      thumbnail: "data:image/png;base64,abc",
    });
    expect(updated.elementsJson).toBe('[{"id":"1"}]');
    expect(updated.thumbnail).toBe("data:image/png;base64,abc");
    db.close();
  });

  test("throws for missing whiteboard", async () => {
    const { db } = await setup();
    expect(() => updateWhiteboard(db, 999, { name: "X" })).toThrow("whiteboard 999 not found");
    db.close();
  });

  test("rejects empty name", async () => {
    const { db } = await setup();
    const wb = createWhiteboard(db, { project: "alpha", name: "X", createdBy: "owner" });
    expect(() => updateWhiteboard(db, wb.id, { name: "  " })).toThrow("whiteboard name is required");
    db.close();
  });
});

describe("deleteWhiteboard", () => {
  test("removes whiteboard", async () => {
    const { db } = await setup();
    const wb = createWhiteboard(db, { project: "alpha", name: "X", createdBy: "owner" });
    deleteWhiteboard(db, wb.id);
    expect(getWhiteboard(db, wb.id)).toBeNull();
    db.close();
  });
});

describe("canEditWhiteboard", () => {
  test("admin can always edit", async () => {
    const { db } = await setup();
    const wb = createWhiteboard(db, { project: "alpha", name: "X", createdBy: "other" });
    const project = { name: "alpha", createdBy: "other" } as any;
    const admin: User = { id: "owner", username: "owner", role: "admin" } as any;
    expect(canEditWhiteboard(admin, wb, project)).toBe(true);
    db.close();
  });

  test("project owner can edit", async () => {
    const { db } = await setup();
    const wb = createWhiteboard(db, { project: "alpha", name: "X", createdBy: "other" });
    const project = { name: "alpha", createdBy: "owner" } as any;
    const user: User = { id: "owner", username: "owner", role: "user" } as any;
    expect(canEditWhiteboard(user, wb, project)).toBe(true);
    db.close();
  });

  test("whiteboard creator can edit", async () => {
    const { db } = await setup();
    const wb = createWhiteboard(db, { project: "alpha", name: "X", createdBy: "other" });
    const project = { name: "alpha", createdBy: "someone-else" } as any;
    const user: User = { id: "other", username: "other", role: "user" } as any;
    expect(canEditWhiteboard(user, wb, project)).toBe(true);
    db.close();
  });

  test("random user cannot edit", async () => {
    const { db } = await setup();
    const wb = createWhiteboard(db, { project: "alpha", name: "X", createdBy: "owner" });
    const project = { name: "alpha", createdBy: "owner" } as any;
    const user: User = { id: "random", username: "random", role: "user" } as any;
    expect(canEditWhiteboard(user, wb, project)).toBe(false);
    db.close();
  });
});
