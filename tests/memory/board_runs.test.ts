import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/memory/db.ts";
import { createProject } from "../../src/memory/projects.ts";
import { listSwimlanes } from "../../src/memory/board_swimlanes.ts";
import { createCard } from "../../src/memory/board_cards.ts";
import {
  createRun,
  getRun,
  listRunsForCard,
  markRunDone,
  markRunError,
  markRunRunning,
} from "../../src/memory/board_runs.ts";

let tmp: string;

async function newDb() {
  tmp = mkdtempSync(join(tmpdir(), "bunny-board-runs-"));
  return openDb(join(tmp, "test.sqlite"));
}

async function setupCard() {
  const db = await newDb();
  createProject(db, { name: "alpha" });
  const lane = listSwimlanes(db, "alpha")[0]!;
  const card = createCard(db, {
    project: "alpha",
    swimlaneId: lane.id,
    title: "do thing",
    assigneeAgent: "researcher",
    createdBy: "u1",
  });
  return { db, cardId: card.id };
}

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

test("createRun defaults to status='running' + trigger_kind='manual'", async () => {
  const { db, cardId } = await setupCard();
  const run = createRun(db, {
    cardId,
    sessionId: "s1",
    agent: "researcher",
    triggeredBy: "u1",
  });
  expect(run.status).toBe("running");
  expect(run.triggerKind).toBe("manual");
  expect(run.finishedAt).toBeNull();
  db.close();
});

test("markRunDone mirrors finalAnswer + sets finished_at", async () => {
  const { db, cardId } = await setupCard();
  const run = createRun(db, {
    cardId,
    sessionId: "s1",
    agent: "researcher",
    triggeredBy: "u1",
  });
  markRunDone(db, run.id, { finalAnswer: "all clear" });
  const reloaded = getRun(db, run.id)!;
  expect(reloaded.status).toBe("done");
  expect(reloaded.finalAnswer).toBe("all clear");
  expect(reloaded.finishedAt).not.toBeNull();
  db.close();
});

test("markRunError captures error string", async () => {
  const { db, cardId } = await setupCard();
  const run = createRun(db, {
    cardId,
    sessionId: "s1",
    agent: "researcher",
    triggeredBy: "u1",
  });
  markRunError(db, run.id, "boom");
  const reloaded = getRun(db, run.id)!;
  expect(reloaded.status).toBe("error");
  expect(reloaded.error).toBe("boom");
  db.close();
});

test("markRunRunning is a no-op transition (idempotent)", async () => {
  const { db, cardId } = await setupCard();
  const run = createRun(db, {
    cardId,
    sessionId: "s1",
    agent: "researcher",
    triggeredBy: "u1",
    status: "queued",
  });
  markRunRunning(db, run.id);
  expect(getRun(db, run.id)!.status).toBe("running");
  db.close();
});

test("listRunsForCard sorts newest first", async () => {
  const { db, cardId } = await setupCard();
  const r1 = createRun(db, {
    cardId,
    sessionId: "s1",
    agent: "researcher",
    triggeredBy: "u1",
  });
  await Bun.sleep(2);
  const r2 = createRun(db, {
    cardId,
    sessionId: "s2",
    agent: "researcher",
    triggeredBy: "u1",
  });
  const runs = listRunsForCard(db, cardId);
  expect(runs.map((r) => r.id)).toEqual([r2.id, r1.id]);
  db.close();
});
