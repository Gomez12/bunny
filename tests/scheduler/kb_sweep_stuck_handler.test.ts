/**
 * Ensures the KB sweep handler resets stuck llm/svg `generating` rows back to
 * idle and logs the result via the queue. Memory-layer coverage of
 * `resetStuckGenerating` lives in `tests/memory/kb_definitions.test.ts` —
 * this file just validates the handler's wiring.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../../src/memory/db.ts";
import { createProject } from "../../src/memory/projects.ts";
import { createUser } from "../../src/auth/users.ts";
import {
  createDefinition,
  getDefinition,
  setLlmGenerating,
} from "../../src/memory/kb_definitions.ts";
import { kbSweepStuckHandler } from "../../src/kb/sweep_stuck_handler.ts";
import type { BunnyConfig } from "../../src/config.ts";
import type { BunnyQueue, LogPayload } from "../../src/queue/bunqueue.ts";

let tmp: string;
let db: Database;
let ownerId: string;
const logged: LogPayload[] = [];

const queue: BunnyQueue = {
  log: async (p) => {
    logged.push(p);
  },
  close: async () => {},
};
const cfg = {} as unknown as BunnyConfig;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "bunny-kb-sweep-"));
  db = await openDb(join(tmp, "db.sqlite"));
  const u = await createUser(db, {
    username: "a",
    password: "pw-123456789",
    role: "admin",
  });
  ownerId = u.id;
  createProject(db, { name: "alpha", createdBy: ownerId });
  logged.length = 0;
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

function makeTask() {
  return {
    id: "t-1",
    kind: "system" as const,
    handler: "kb.sweep_stuck",
    name: "sweep",
    description: null,
    cronExpr: "*/5 * * * *",
    payload: null,
    enabled: true,
    ownerUserId: null,
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    nextRunAt: 0,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe("kbSweepStuckHandler", () => {
  test("resets stuck llm rows and logs the reset", async () => {
    const d = createDefinition(db, {
      project: "alpha",
      term: "stuck",
      createdBy: ownerId,
    });
    setLlmGenerating(db, d.id);
    db.run(`UPDATE kb_definitions SET updated_at = ? WHERE id = ?`, [
      Date.now() - 60 * 60_000,
      d.id,
    ]);

    await kbSweepStuckHandler({
      db,
      queue,
      cfg,
      task: makeTask(),
      payload: null,
      now: Date.now(),
    });

    expect(getDefinition(db, d.id)!.llmStatus).toBe("idle");
    expect(logged).toHaveLength(1);
    expect(logged[0]!.topic).toBe("kb");
    expect(logged[0]!.kind).toBe("sweep.stuck");
    const data = logged[0]!.data as { llmReset: number[]; svgReset: number[] };
    expect(data.llmReset).toEqual([d.id]);
    expect(data.svgReset).toEqual([]);
  });

  test("is a no-op (no log emitted) when nothing is stuck", async () => {
    const d = createDefinition(db, {
      project: "alpha",
      term: "fresh",
      createdBy: ownerId,
    });
    setLlmGenerating(db, d.id);

    await kbSweepStuckHandler({
      db,
      queue,
      cfg,
      task: makeTask(),
      payload: null,
      now: Date.now(),
    });

    expect(getDefinition(db, d.id)!.llmStatus).toBe("generating");
    expect(logged).toHaveLength(0);
  });
});
