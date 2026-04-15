import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../../src/memory/db.ts";
import {
  claimDueTasks,
  createTask,
  deleteTask,
  ensureSystemTask,
  getTask,
  listTasks,
  setTaskResult,
  updateTask,
} from "../../src/memory/scheduled_tasks.ts";

let tmp: string;
let db: Database;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "bunny-sched-tasks-"));
  db = await openDb(join(tmp, "db.sqlite"));
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("scheduled_tasks", () => {
  test("create/list/update/delete roundtrip", () => {
    const t = createTask(db, {
      kind: "user",
      handler: "demo.ping",
      name: "demo",
      cronExpr: "* * * * *",
      nextRunAt: 1000,
      payload: { hello: "world" },
    });
    expect(t.id).toBeTruthy();
    expect(t.enabled).toBe(true);
    expect(t.payload).toEqual({ hello: "world" });

    expect(listTasks(db)).toHaveLength(1);
    expect(listTasks(db, { kind: "user" })).toHaveLength(1);
    expect(listTasks(db, { kind: "system" })).toHaveLength(0);

    const updated = updateTask(db, t.id, { name: "renamed", enabled: false });
    expect(updated.name).toBe("renamed");
    expect(updated.enabled).toBe(false);

    deleteTask(db, t.id);
    expect(getTask(db, t.id)).toBeNull();
  });

  test("claimDueTasks only picks enabled + due rows and bumps next_run_at", () => {
    const now = 10_000;
    createTask(db, { kind: "system", handler: "a", name: "a", cronExpr: "* * * * *", nextRunAt: 5_000 });
    createTask(db, { kind: "user", handler: "b", name: "b", cronExpr: "* * * * *", nextRunAt: 20_000 });
    const disabled = createTask(db, {
      kind: "user",
      handler: "c",
      name: "c",
      cronExpr: "* * * * *",
      nextRunAt: 0,
      enabled: false,
    });

    const claimed = claimDueTasks(db, now);
    expect(claimed.map((t) => t.handler).sort()).toEqual(["a"]);
    // The claimed row's next_run_at was bumped so a parallel tick would skip it.
    const aAgain = listTasks(db).find((t) => t.handler === "a")!;
    expect(aAgain.nextRunAt).toBeGreaterThan(now);
    // Disabled rows are never claimed.
    expect(getTask(db, disabled.id)!.nextRunAt).toBe(0);
  });

  test("setTaskResult stores status + computed next run", () => {
    const t = createTask(db, {
      kind: "system",
      handler: "x",
      name: "x",
      cronExpr: "* * * * *",
      nextRunAt: 0,
    });
    setTaskResult(db, t.id, { status: "error", error: "boom", nextRunAt: 99_000 });
    const after = getTask(db, t.id)!;
    expect(after.lastStatus).toBe("error");
    expect(after.lastError).toBe("boom");
    expect(after.nextRunAt).toBe(99_000);
  });

  test("ensureSystemTask is idempotent per handler", () => {
    const a = ensureSystemTask(db, "board.auto_run_scan", {
      name: "seed",
      cronExpr: "*/5 * * * *",
      nextRunAt: 1000,
    });
    const b = ensureSystemTask(db, "board.auto_run_scan", {
      name: "seed-again",
      cronExpr: "*/5 * * * *",
      nextRunAt: 2000,
    });
    expect(a.id).toBe(b.id);
    expect(listTasks(db, { kind: "system" })).toHaveLength(1);
  });
});
