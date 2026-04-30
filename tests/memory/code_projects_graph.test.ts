import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/memory/db.ts";
import {
  createCodeProject,
  getCodeProject,
  setGraphError,
  setGraphPhase,
  setGraphReady,
} from "../../src/memory/code_projects.ts";
import { ensureSeedUsers } from "../../src/auth/seed.ts";

let tmp: string;
let db: Awaited<ReturnType<typeof openDb>>;
let adminId: string;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "bunny-graph-setters-"));
  process.env["BUNNY_HOME"] = tmp;
  db = await openDb(join(tmp, "test.sqlite"));
  await ensureSeedUsers(db, {
    defaultAdminUsername: "admin",
    defaultAdminPassword: "pw",
    sessionTtlHours: 24,
  });
  adminId = (
    db.prepare(`SELECT id FROM users WHERE username = 'admin'`).get() as {
      id: string;
    }
  ).id;
  db.run(
    "INSERT INTO projects(name, description, visibility, created_by, created_at, updated_at) VALUES ('p', '', 'public', NULL, ?, ?) ON CONFLICT DO NOTHING",
    [Date.now(), Date.now()],
  );
});

afterEach(() => {
  db.close();
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("graph status setters", () => {
  test("default state is idle with NULL counts", () => {
    const cp = createCodeProject(db, {
      project: "p",
      name: "alpha",
      createdBy: adminId,
    });
    const fresh = getCodeProject(db, cp.id)!;
    expect(fresh.graphStatus).toBe("idle");
    expect(fresh.graphNodeCount).toBeNull();
    expect(fresh.graphEdgeCount).toBeNull();
    expect(fresh.lastGraphedAt).toBeNull();
  });

  test("setGraphPhase('extracting') is atomic; second concurrent caller loses", () => {
    const cp = createCodeProject(db, {
      project: "p",
      name: "beta",
      createdBy: adminId,
    });
    expect(setGraphPhase(db, cp.id, "extracting")).toBe(true);
    expect(setGraphPhase(db, cp.id, "extracting")).toBe(false);
    // A caller that already owns the run can still advance the phase.
    expect(setGraphPhase(db, cp.id, "clustering")).toBe(true);
    expect(getCodeProject(db, cp.id)!.graphStatus).toBe("clustering");
  });

  test("setGraphReady stamps counts and timestamp", () => {
    const cp = createCodeProject(db, {
      project: "p",
      name: "gamma",
      createdBy: adminId,
    });
    setGraphPhase(db, cp.id, "extracting");
    setGraphReady(db, cp.id, { nodes: 12, edges: 7 });
    const fresh = getCodeProject(db, cp.id)!;
    expect(fresh.graphStatus).toBe("ready");
    expect(fresh.graphNodeCount).toBe(12);
    expect(fresh.graphEdgeCount).toBe(7);
    expect(fresh.lastGraphedAt).not.toBeNull();
  });

  test("setGraphError records the message", () => {
    const cp = createCodeProject(db, {
      project: "p",
      name: "delta",
      createdBy: adminId,
    });
    setGraphError(db, cp.id, "oops");
    const fresh = getCodeProject(db, cp.id)!;
    expect(fresh.graphStatus).toBe("error");
    expect(fresh.graphError).toBe("oops");
  });

  test("after error a new extract attempt can claim the row", () => {
    const cp = createCodeProject(db, {
      project: "p",
      name: "epsilon",
      createdBy: adminId,
    });
    setGraphError(db, cp.id, "earlier failure");
    expect(setGraphPhase(db, cp.id, "extracting")).toBe(true);
  });
});
