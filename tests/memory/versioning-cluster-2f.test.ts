/**
 * Phase 2f round-trip smoke tests — agent, skill, board_swimlane,
 * scheduled_task, web_news_topic, contact_group, planning_suggestion.
 * planning_report is intentionally not registered (insert-only artefact).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/memory/db.ts";
import { createProject } from "../../src/memory/projects.ts";
import { createAgent, getAgent, updateAgent } from "../../src/memory/agents.ts";
import { createSkill, getSkill, updateSkill } from "../../src/memory/skills.ts";
import {
  createSwimlane,
  getSwimlane,
  updateSwimlane,
} from "../../src/memory/board_swimlanes.ts";
import {
  createTask,
  getTask,
  updateTask,
} from "../../src/memory/scheduled_tasks.ts";
import {
  createTopic,
  getTopic,
  updateTopic,
} from "../../src/memory/web_news.ts";
import {
  createGroup,
  getGroup,
  updateGroup,
} from "../../src/memory/contacts.ts";
import { createPlanningProject } from "../../src/memory/planning_projects.ts";
import {
  acceptPending,
  getPendingSuggestion,
  replacePending,
} from "../../src/memory/planning_suggestions.ts";
import {
  configureVersioning,
  recordVersion,
  restoreVersion,
} from "../../src/memory/versioning.ts";

let tmp: string;

async function setup() {
  tmp = mkdtempSync(join(tmpdir(), "bunny-versioning-2f-"));
  const db = await openDb(join(tmp, "test.sqlite"));
  const now = Date.now();
  db.run(
    `INSERT INTO users(id, username, password_hash, role, created_at, updated_at)
     VALUES ('alice', 'alice', 'x', 'admin', ?, ?)`,
    [now, now],
  );
  createProject(db, { name: "alpha", createdBy: "alice" });
  return db;
}

beforeEach(() => {
  configureVersioning({ debounceMinutes: 0, maxSnapshotBytes: 1_048_576 });
});

afterEach(() => {
  configureVersioning({ debounceMinutes: 5, maxSnapshotBytes: 1_048_576 });
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("agent versioning", () => {
  test("restoreVersion reverts description + visibility (name immutable)", async () => {
    const db = await setup();
    createAgent(db, {
      name: "scout",
      description: "first",
      visibility: "private",
      createdBy: "alice",
    });
    recordVersion(db, "agent", "scout", "save", "alice");

    updateAgent(db, "scout", { description: "second", visibility: "public" });
    recordVersion(db, "agent", "scout", "save", "alice");

    restoreVersion(db, "agent", "scout", 1, "alice");
    const restored = getAgent(db, "scout")!;
    expect(restored.description).toBe("first");
    expect(restored.visibility).toBe("private");
    db.close();
  });
});

describe("skill versioning", () => {
  test("restoreVersion reverts description + source_url", async () => {
    const db = await setup();
    createSkill(db, {
      name: "draft",
      description: "first",
      visibility: "private",
      sourceUrl: "https://a.example",
      createdBy: "alice",
    });
    recordVersion(db, "skill", "draft", "save", "alice");

    updateSkill(db, "draft", {
      description: "second",
      sourceUrl: "https://b.example",
    });
    recordVersion(db, "skill", "draft", "save", "alice");

    restoreVersion(db, "skill", "draft", 1, "alice");
    const restored = getSkill(db, "draft")!;
    expect(restored.description).toBe("first");
    expect(restored.sourceUrl).toBe("https://a.example");
    db.close();
  });
});

describe("board_swimlane versioning", () => {
  test("restoreVersion reverts wip_limit + auto_run, leaves position", async () => {
    const db = await setup();
    const lane = createSwimlane(db, {
      project: "alpha",
      name: "Lane-A",
      position: 100,
      wipLimit: 3,
      autoRun: false,
    });
    recordVersion(db, "board_swimlane", lane.id, "save", "alice");

    updateSwimlane(db, lane.id, { wipLimit: 10, autoRun: true });
    recordVersion(db, "board_swimlane", lane.id, "save", "alice");

    restoreVersion(db, "board_swimlane", lane.id, 1, "alice");
    const restored = getSwimlane(db, lane.id)!;
    expect(restored.wipLimit).toBe(3);
    expect(restored.autoRun).toBe(false);
    // Position is intentionally not snapshotted — keep as set.
    expect(restored.position).toBe(100);
    db.close();
  });
});

describe("scheduled_task versioning", () => {
  test("restoreVersion reverts cron_expr + enabled, worker bookkeeping untouched", async () => {
    const db = await setup();
    const task = createTask(db, {
      kind: "user",
      handler: "demo.handler",
      name: "nightly",
      description: "first",
      cronExpr: "0 0 * * *",
      enabled: true,
      nextRunAt: Date.now() + 60_000,
      ownerUserId: "alice",
    });
    recordVersion(db, "scheduled_task", task.id, "save", "alice");

    updateTask(db, task.id, {
      description: "second",
      cronExpr: "0 12 * * *",
      enabled: false,
    });
    recordVersion(db, "scheduled_task", task.id, "save", "alice");

    restoreVersion(db, "scheduled_task", task.id, 1, "alice");
    const restored = getTask(db, task.id)!;
    expect(restored.description).toBe("first");
    expect(restored.cronExpr).toBe("0 0 * * *");
    expect(restored.enabled).toBe(true);
    db.close();
  });
});

describe("web_news_topic versioning", () => {
  test("restoreVersion reverts terms + cron, worker run state preserved", async () => {
    const db = await setup();
    const topic = createTopic(db, {
      project: "alpha",
      name: "news-a",
      agent: "news",
      terms: ["alpha"],
      updateCron: "0 8 * * *",
      nextUpdateAt: Date.now() + 60_000,
      createdBy: "alice",
    });
    recordVersion(db, "web_news_topic", topic.id, "save", "alice");

    updateTopic(db, topic.id, {
      terms: ["beta", "gamma"],
      updateCron: "0 12 * * *",
      nextUpdateAt: Date.now() + 120_000,
    });
    recordVersion(db, "web_news_topic", topic.id, "save", "alice");

    restoreVersion(db, "web_news_topic", topic.id, 1, "alice");
    const restored = getTopic(db, topic.id)!;
    expect(restored.terms).toEqual(["alpha"]);
    expect(restored.updateCron).toBe("0 8 * * *");
    db.close();
  });
});

describe("contact_group versioning", () => {
  test("restoreVersion reverts name + color", async () => {
    const db = await setup();
    const g = createGroup(db, {
      project: "alpha",
      name: "VIPs",
      color: "#aaa",
      createdBy: "alice",
    });
    recordVersion(db, "contact_group", g.id, "save", "alice");

    updateGroup(db, g.id, { name: "VIPs-renamed", color: "#bbb" });
    recordVersion(db, "contact_group", g.id, "save", "alice");

    restoreVersion(db, "contact_group", g.id, 1, "alice");
    const restored = getGroup(db, g.id)!;
    expect(restored.name).toBe("VIPs");
    expect(restored.color).toBe("#aaa");
    db.close();
  });
});

describe("planning_suggestion versioning", () => {
  test("restoreVersion reverts decision_comment, status stays live", async () => {
    const db = await setup();
    const pp = createPlanningProject(db, {
      project: "alpha",
      name: "roadmap",
      createdBy: "alice",
    });
    replacePending(db, pp.id, { placements: [], bottlenecks: [] }, "alice");
    const pending = getPendingSuggestion(db, pp.id)!;
    // Snapshot the pending row before any decision.
    recordVersion(db, "planning_suggestion", pending.id, "save", "alice");

    acceptPending(db, pp.id, "alice", "approved with notes");
    recordVersion(db, "planning_suggestion", pending.id, "save", "alice");

    restoreVersion(db, "planning_suggestion", pending.id, 1, "alice");
    // decision_comment is part of the snapshot — version 1 had empty comment.
    const row = db
      .prepare(
        `SELECT decision_comment, status FROM planning_suggestions WHERE id = ?`,
      )
      .get(pending.id) as { decision_comment: string; status: string };
    expect(row.decision_comment).toBe("");
    // Status is intentionally NOT restored (would collide with the unique
    // pending index). It stays at whatever the live row last said.
    expect(row.status).toBe("accepted");
    db.close();
  });
});
