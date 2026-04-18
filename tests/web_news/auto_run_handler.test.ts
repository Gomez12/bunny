/**
 * Tests for `selectDueTopics`'s interaction with the scan handler: a running
 * topic must never be re-selected by the next tick. The handler itself spawns
 * `runTopic` which calls the LLM — we test the selection guard here, not the
 * LLM path (that's covered by `run_topic_renew.test.ts` + integration).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/memory/db.ts";
import { createProject } from "../../src/memory/projects.ts";
import {
  claimTopicForRun,
  createTopic,
  selectDueTopics,
} from "../../src/memory/web_news.ts";

let tmp: string;

async function setup() {
  tmp = mkdtempSync(join(tmpdir(), "bunny-news-scan-"));
  const db = await openDb(join(tmp, "test.sqlite"));
  const now = Date.now();
  db.run(
    `INSERT INTO users(id, username, password_hash, role, created_at, updated_at)
     VALUES ('owner', 'owner', 'x', 'admin', ?, ?)`,
    [now, now],
  );
  createProject(db, { name: "alpha", createdBy: "owner" });
  return { db };
}

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("selectDueTopics concurrency guard", () => {
  test("running topic is NOT re-selected on the next tick", async () => {
    const { db } = await setup();
    const t = createTopic(db, {
      project: "alpha",
      name: "feed",
      agent: "a",
      updateCron: "* * * * *",
      nextUpdateAt: 0,
      createdBy: "owner",
    });
    expect(selectDueTopics(db, 1_000).map((d) => d.id)).toContain(t.id);

    // Claim — simulates the scan handler starting the agent.
    expect(claimTopicForRun(db, t.id)).toBe(true);

    // Next tick while the run is still in flight must NOT re-pick it.
    expect(selectDueTopics(db, 2_000).map((d) => d.id)).not.toContain(t.id);

    // A second claim attempt (concurrent tick) must lose the race.
    expect(claimTopicForRun(db, t.id)).toBe(false);
  });

  test("disabled topics are never due", async () => {
    const { db } = await setup();
    createTopic(db, {
      project: "alpha",
      name: "off",
      agent: "a",
      updateCron: "* * * * *",
      nextUpdateAt: 0,
      enabled: false,
      createdBy: "owner",
    });
    expect(selectDueTopics(db, 1_000)).toEqual([]);
  });
});
