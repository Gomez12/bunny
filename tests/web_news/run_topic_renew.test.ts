/**
 * Regression: regenerate-terms must not create a tick-every-minute loop when
 * the topic has no `renew_terms_cron`. See ADR 0024 and advisor feedback.
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
  getTopic,
  releaseTopic,
  selectDueTopics,
} from "../../src/memory/web_news.ts";

let tmp: string;

async function setup() {
  tmp = mkdtempSync(join(tmpdir(), "bunny-news-renew-"));
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

describe("regenerate-terms without renew cron", () => {
  test("renew-mode release clears next_renew_terms_at to null", async () => {
    const { db } = await setup();
    // Topic with renew mode = "never" (no cron, always_regen = 0).
    const t = createTopic(db, {
      project: "alpha",
      name: "feed",
      agent: "a",
      terms: ["x"],
      updateCron: "* * * * *",
      renewTermsCron: null,
      nextUpdateAt: 9_999_999,
      createdBy: "owner",
    });
    // Simulate the "Regenerate terms" endpoint zeroing the timestamp.
    db.run(`UPDATE web_news_topics SET next_renew_terms_at = 0 WHERE id = ?`, [
      t.id,
    ]);

    // Scheduler picks it up on the next tick.
    const dueBefore = selectDueTopics(db, 1_000);
    expect(dueBefore.map((d) => d.id)).toContain(t.id);
    expect(dueBefore.find((d) => d.id === t.id)!.renewDue).toBe(true);

    // Simulate a successful renew+fetch run releasing the topic with
    // `nextRenewTermsAt = null` (no cron configured).
    claimTopicForRun(db, t.id);
    releaseTopic(db, t.id, {
      status: "ok",
      nextUpdateAt: 20_000_000,
      nextRenewTermsAt: null,
      terms: ["new-term"],
    });
    expect(getTopic(db, t.id)!.nextRenewTermsAt).toBeNull();

    // It must not be re-selected as renew-due on the next scheduler tick.
    const dueAfter = selectDueTopics(db, 2_000);
    expect(dueAfter.some((d) => d.id === t.id)).toBe(false);
  });
});
