import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/memory/db.ts";
import { createProject } from "../../src/memory/projects.ts";
import {
  canEditCodeProject,
  createCodeProject,
  deleteCodeProject,
  getCodeProject,
  listCodeProjects,
  setGitCloning,
  setGitError,
  setGitReady,
  updateCodeProject,
  validateCodeProjectName,
} from "../../src/memory/code_projects.ts";
import { listTrash, restore } from "../../src/memory/trash.ts";
import type { User } from "../../src/auth/users.ts";

let tmp: string;

async function newDb() {
  tmp = mkdtempSync(join(tmpdir(), "bunny-code-projects-"));
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

describe("validateCodeProjectName", () => {
  test("accepts valid slugs", () => {
    expect(validateCodeProjectName("my-repo")).toBe("my-repo");
    expect(validateCodeProjectName("a")).toBe("a");
    expect(validateCodeProjectName("MY_REPO")).toBe("my_repo");
    expect(validateCodeProjectName("a1b2_c-d")).toBe("a1b2_c-d");
  });

  test("rejects path traversal and funky characters", () => {
    expect(() => validateCodeProjectName("../etc")).toThrow();
    expect(() => validateCodeProjectName("a/b")).toThrow();
    expect(() => validateCodeProjectName("-leading")).toThrow();
    expect(() => validateCodeProjectName(".")).toThrow();
    expect(() => validateCodeProjectName("..")).toThrow();
    expect(() => validateCodeProjectName("with space")).toThrow();
    expect(() => validateCodeProjectName("")).toThrow();
  });
});

describe("createCodeProject", () => {
  test("creates with defaults and idle status when no git url", async () => {
    const { db } = await setup();
    const cp = createCodeProject(db, {
      project: "alpha",
      name: "my-repo",
      createdBy: "owner",
    });
    expect(cp.id).toBeGreaterThan(0);
    expect(cp.project).toBe("alpha");
    expect(cp.name).toBe("my-repo");
    expect(cp.gitUrl).toBeNull();
    expect(cp.gitRef).toBeNull();
    expect(cp.gitStatus).toBe("idle");
    expect(cp.createdBy).toBe("owner");
    db.close();
  });

  test("starts in 'cloning' state when a git url is provided", async () => {
    const { db } = await setup();
    const cp = createCodeProject(db, {
      project: "alpha",
      name: "clone-test",
      gitUrl: "https://github.com/example/repo.git",
      createdBy: "owner",
    });
    expect(cp.gitUrl).toBe("https://github.com/example/repo.git");
    expect(cp.gitStatus).toBe("cloning");
    db.close();
  });

  test("UNIQUE(project, name) is enforced", async () => {
    const { db } = await setup();
    createCodeProject(db, {
      project: "alpha",
      name: "dup",
      createdBy: "owner",
    });
    expect(() =>
      createCodeProject(db, {
        project: "alpha",
        name: "dup",
        createdBy: "owner",
      }),
    ).toThrow();
    // Same name in another project is fine.
    const cp = createCodeProject(db, {
      project: "beta",
      name: "dup",
      createdBy: "owner",
    });
    expect(cp.project).toBe("beta");
    db.close();
  });

  test("rejects invalid names before touching the db", async () => {
    const { db } = await setup();
    expect(() =>
      createCodeProject(db, {
        project: "alpha",
        name: "../etc",
        createdBy: "owner",
      }),
    ).toThrow();
    expect(listCodeProjects(db, "alpha").length).toBe(0);
    db.close();
  });
});

describe("listCodeProjects / getCodeProject", () => {
  test("only returns live rows, newest first", async () => {
    const { db } = await setup();
    const a = createCodeProject(db, {
      project: "alpha",
      name: "a",
      createdBy: "owner",
    });
    const b = createCodeProject(db, {
      project: "alpha",
      name: "b",
      createdBy: "owner",
    });
    // Wait a tick so updated_at is strictly newer, then touch a.
    await new Promise((r) => setTimeout(r, 5));
    updateCodeProject(db, a.id, { description: "tweak" });
    const list = listCodeProjects(db, "alpha");
    expect(list.map((c) => c.id)).toEqual([a.id, b.id]);
    db.close();
  });

  test("getCodeProject returns null for unknown or soft-deleted", async () => {
    const { db } = await setup();
    const cp = createCodeProject(db, {
      project: "alpha",
      name: "trashme",
      createdBy: "owner",
    });
    deleteCodeProject(db, cp.id, "owner");
    expect(getCodeProject(db, cp.id)).toBeNull();
    expect(getCodeProject(db, 999999)).toBeNull();
    db.close();
  });
});

describe("soft-delete + trash integration", () => {
  test("soft-delete hides from list and surfaces in trash", async () => {
    const { db } = await setup();
    const cp = createCodeProject(db, {
      project: "alpha",
      name: "trashed",
      createdBy: "owner",
    });
    deleteCodeProject(db, cp.id, "owner");
    expect(
      listCodeProjects(db, "alpha").find((c) => c.id === cp.id),
    ).toBeUndefined();
    const trash = listTrash(db).filter((t) => t.kind === "code_project");
    expect(trash.length).toBe(1);
    expect(trash[0]!.name).toBe("trashed");
    db.close();
  });

  test("restore brings the row back under its original name", async () => {
    const { db } = await setup();
    const cp = createCodeProject(db, {
      project: "alpha",
      name: "restore-me",
      createdBy: "owner",
    });
    deleteCodeProject(db, cp.id, "owner");
    expect(restore(db, "code_project", cp.id)).toBe("ok");
    const live = listCodeProjects(db, "alpha");
    expect(live.find((c) => c.id === cp.id)?.name).toBe("restore-me");
    db.close();
  });

  test("soft-delete frees UNIQUE(project, name) for a new row", async () => {
    const { db } = await setup();
    const a = createCodeProject(db, {
      project: "alpha",
      name: "name-collide",
      createdBy: "owner",
    });
    deleteCodeProject(db, a.id, "owner");
    const b = createCodeProject(db, {
      project: "alpha",
      name: "name-collide",
      createdBy: "owner",
    });
    expect(b.id).not.toBe(a.id);
    db.close();
  });
});

describe("git status setters", () => {
  test("setGitCloning is idempotent and wins exactly once", async () => {
    const { db } = await setup();
    const cp = createCodeProject(db, {
      project: "alpha",
      name: "cloning-race",
      createdBy: "owner",
    });
    // Freshly-created row with no gitUrl is 'idle'.
    expect(cp.gitStatus).toBe("idle");
    expect(setGitCloning(db, cp.id)).toBe(true);
    // Second call finds the row already in 'cloning' → no-op.
    expect(setGitCloning(db, cp.id)).toBe(false);
    db.close();
  });

  test("setGitReady / setGitError transition terminally", async () => {
    const { db } = await setup();
    const cp = createCodeProject(db, {
      project: "alpha",
      name: "states",
      gitUrl: "https://example.org/repo.git",
      createdBy: "owner",
    });
    expect(cp.gitStatus).toBe("cloning");
    setGitReady(db, cp.id);
    expect(getCodeProject(db, cp.id)?.gitStatus).toBe("ready");
    setGitError(db, cp.id, "network down");
    const errRow = getCodeProject(db, cp.id);
    expect(errRow?.gitStatus).toBe("error");
    expect(errRow?.gitError).toBe("network down");
    db.close();
  });
});

describe("canEditCodeProject", () => {
  test("admin + project creator + row creator can edit", async () => {
    const { db } = await setup();
    const cp = createCodeProject(db, {
      project: "alpha",
      name: "perm",
      createdBy: "other",
    });
    const fresh = getCodeProject(db, cp.id)!;
    const project = { createdBy: "owner" } as unknown as Parameters<
      typeof canEditCodeProject
    >[2];
    const owner = { id: "owner", role: "admin" } as unknown as User;
    const other = { id: "other", role: "user" } as unknown as User;
    const stranger = { id: "third", role: "user" } as unknown as User;
    expect(canEditCodeProject(owner, fresh, project)).toBe(true);
    expect(canEditCodeProject(other, fresh, project)).toBe(true);
    expect(canEditCodeProject(stranger, fresh, project)).toBe(false);
    db.close();
  });
});
