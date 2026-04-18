import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/memory/db.ts";
import { createProject, getProject } from "../../src/memory/projects.ts";
import { listSwimlanes } from "../../src/memory/board_swimlanes.ts";
import {
  archiveCard,
  canEditCard,
  createCard,
  getCard,
  listCards,
  moveCard,
  updateCard,
} from "../../src/memory/board_cards.ts";
import type { User } from "../../src/auth/users.ts";

let tmp: string;

async function newDb() {
  tmp = mkdtempSync(join(tmpdir(), "bunny-board-cards-"));
  return openDb(join(tmp, "test.sqlite"));
}

async function setup() {
  const db = await newDb();
  // Seed a fake owner user to satisfy projects.created_by FK.
  const now = Date.now();
  db.run(
    `INSERT INTO users(id, username, password_hash, role, created_at, updated_at)
     VALUES ('owner', 'owner', 'x', 'user', ?, ?)`,
    [now, now],
  );
  createProject(db, { name: "alpha", createdBy: "owner" });
  const [todo, doing] = listSwimlanes(db, "alpha");
  return { db, todo: todo!, doing: doing! };
}

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("createCard", () => {
  test("requires non-empty title", async () => {
    const { db, todo } = await setup();
    expect(() =>
      createCard(db, {
        project: "alpha",
        swimlaneId: todo.id,
        title: "  ",
        createdBy: "u1",
      }),
    ).toThrow();
    db.close();
  });

  test("rejects double assignee (user + agent)", async () => {
    const { db, todo } = await setup();
    expect(() =>
      createCard(db, {
        project: "alpha",
        swimlaneId: todo.id,
        title: "x",
        assigneeUserId: "u1",
        assigneeAgent: "researcher",
        createdBy: "u1",
      }),
    ).toThrow(/either a user or an agent/);
    db.close();
  });

  test("appends with sparse positions per lane", async () => {
    const { db, todo } = await setup();
    const a = createCard(db, {
      project: "alpha",
      swimlaneId: todo.id,
      title: "a",
      createdBy: "u1",
    });
    const b = createCard(db, {
      project: "alpha",
      swimlaneId: todo.id,
      title: "b",
      createdBy: "u1",
    });
    expect(b.position).toBeGreaterThan(a.position);
    expect(b.position - a.position).toBe(100);
    db.close();
  });
});

describe("listCards", () => {
  test("excludes archived by default", async () => {
    const { db, todo } = await setup();
    const c = createCard(db, {
      project: "alpha",
      swimlaneId: todo.id,
      title: "live",
      createdBy: "u1",
    });
    const d = createCard(db, {
      project: "alpha",
      swimlaneId: todo.id,
      title: "dead",
      createdBy: "u1",
    });
    archiveCard(db, d.id);
    expect(listCards(db, "alpha").map((x) => x.id)).toEqual([c.id]);
    expect(listCards(db, "alpha", { includeArchived: true })).toHaveLength(2);
    db.close();
  });

  test("scoped to project", async () => {
    const { db, todo } = await setup();
    createProject(db, { name: "beta" });
    const otherLane = listSwimlanes(db, "beta")[0]!;
    createCard(db, {
      project: "alpha",
      swimlaneId: todo.id,
      title: "in alpha",
      createdBy: "u1",
    });
    createCard(db, {
      project: "beta",
      swimlaneId: otherLane.id,
      title: "in beta",
      createdBy: "u1",
    });
    expect(listCards(db, "alpha").map((c) => c.title)).toEqual(["in alpha"]);
    expect(listCards(db, "beta").map((c) => c.title)).toEqual(["in beta"]);
    db.close();
  });
});

describe("updateCard", () => {
  test("clearing assignee with null is allowed", async () => {
    const { db, todo } = await setup();
    const c = createCard(db, {
      project: "alpha",
      swimlaneId: todo.id,
      title: "x",
      assigneeUserId: "u1",
      createdBy: "u1",
    });
    const cleared = updateCard(db, c.id, { assigneeUserId: null });
    expect(cleared.assigneeUserId).toBeNull();
    db.close();
  });

  test("setting both assignees throws", async () => {
    const { db, todo } = await setup();
    const c = createCard(db, {
      project: "alpha",
      swimlaneId: todo.id,
      title: "x",
      assigneeUserId: "u1",
      createdBy: "u1",
    });
    expect(() =>
      updateCard(db, c.id, { assigneeAgent: "researcher" }),
    ).toThrow();
    db.close();
  });

  test("estimate hours and percent done round-trip", async () => {
    const { db, todo } = await setup();
    const c = createCard(db, {
      project: "alpha",
      swimlaneId: todo.id,
      title: "tracked",
      estimateHours: 4.5,
      percentDone: 30,
      createdBy: "u1",
    });
    expect(c.estimateHours).toBe(4.5);
    expect(c.percentDone).toBe(30);
    const updated = updateCard(db, c.id, { percentDone: 80 });
    expect(updated.percentDone).toBe(80);
    expect(updated.estimateHours).toBe(4.5);
    const cleared = updateCard(db, c.id, {
      estimateHours: null,
      percentDone: null,
    });
    expect(cleared.estimateHours).toBeNull();
    expect(cleared.percentDone).toBeNull();
    db.close();
  });
});

describe("moveCard", () => {
  test("moves to bottom of new lane when no neighbours given", async () => {
    const { db, todo, doing } = await setup();
    const a = createCard(db, {
      project: "alpha",
      swimlaneId: todo.id,
      title: "a",
      createdBy: "u1",
    });
    const moved = moveCard(db, a.id, { swimlaneId: doing.id });
    expect(moved.swimlaneId).toBe(doing.id);
    expect(moved.position).toBe(100);
    db.close();
  });

  test("midpoint between two neighbours", async () => {
    const { db, todo } = await setup();
    const a = createCard(db, {
      project: "alpha",
      swimlaneId: todo.id,
      title: "a",
      createdBy: "u1",
    });
    const b = createCard(db, {
      project: "alpha",
      swimlaneId: todo.id,
      title: "b",
      createdBy: "u1",
    });
    const c = createCard(db, {
      project: "alpha",
      swimlaneId: todo.id,
      title: "c",
      createdBy: "u1",
    });
    // Move c between a and b.
    const moved = moveCard(db, c.id, {
      swimlaneId: todo.id,
      beforeCardId: a.id,
      afterCardId: b.id,
    });
    expect(moved.position).toBeGreaterThan(a.position);
    expect(moved.position).toBeLessThan(b.position);
    db.close();
  });

  test("place at top using only beforeCardId", async () => {
    const { db, todo } = await setup();
    const a = createCard(db, {
      project: "alpha",
      swimlaneId: todo.id,
      title: "a",
      createdBy: "u1",
    });
    const b = createCard(db, {
      project: "alpha",
      swimlaneId: todo.id,
      title: "b",
      createdBy: "u1",
    });
    const moved = moveCard(db, b.id, {
      swimlaneId: todo.id,
      beforeCardId: a.id,
    });
    expect(moved.position).toBeLessThan(a.position);
    db.close();
  });
});

describe("canEditCard", () => {
  test("admin always passes", async () => {
    const { db, todo } = await setup();
    const c = createCard(db, {
      project: "alpha",
      swimlaneId: todo.id,
      title: "x",
      createdBy: "u2",
    });
    const project = getProject(db, "alpha")!;
    const admin: User = baseUser({ id: "anyone", role: "admin" });
    expect(canEditCard(admin, getCard(db, c.id)!, project)).toBe(true);
    db.close();
  });

  test("owner of project passes", async () => {
    const { db, todo } = await setup();
    const c = createCard(db, {
      project: "alpha",
      swimlaneId: todo.id,
      title: "x",
      createdBy: "u2",
    });
    const project = getProject(db, "alpha")!;
    expect(
      canEditCard(baseUser({ id: "owner" }), getCard(db, c.id)!, project),
    ).toBe(true);
    db.close();
  });

  test("creator passes; random user does not", async () => {
    const { db, todo } = await setup();
    const c = createCard(db, {
      project: "alpha",
      swimlaneId: todo.id,
      title: "x",
      createdBy: "u2",
    });
    const project = getProject(db, "alpha")!;
    expect(
      canEditCard(baseUser({ id: "u2" }), getCard(db, c.id)!, project),
    ).toBe(true);
    expect(
      canEditCard(baseUser({ id: "u3" }), getCard(db, c.id)!, project),
    ).toBe(false);
    db.close();
  });

  test("user-assignee passes", async () => {
    const { db, todo } = await setup();
    const c = createCard(db, {
      project: "alpha",
      swimlaneId: todo.id,
      title: "x",
      assigneeUserId: "u4",
      createdBy: "u2",
    });
    const project = getProject(db, "alpha")!;
    expect(
      canEditCard(baseUser({ id: "u4" }), getCard(db, c.id)!, project),
    ).toBe(true);
    db.close();
  });
});

function baseUser(overrides: Partial<User> & { id: string }): User {
  return {
    id: overrides.id,
    username: overrides.username ?? overrides.id,
    role: overrides.role ?? "user",
    displayName: overrides.displayName ?? null,
    email: overrides.email ?? null,
    mustChangePassword: overrides.mustChangePassword ?? false,
    expandThinkBubbles: overrides.expandThinkBubbles ?? false,
    expandToolBubbles: overrides.expandToolBubbles ?? false,
    createdAt: overrides.createdAt ?? Date.now(),
    updatedAt: overrides.updatedAt ?? Date.now(),
  };
}
