import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/memory/db.ts";
import { createProject } from "../../src/memory/projects.ts";
import {
  canEditTopic,
  claimTopicForRun,
  computeContentHash,
  createTopic,
  deleteTopic,
  getTopic,
  listItemsForProject,
  listRecentItemsForTopic,
  listTopics,
  releaseTopic,
  selectDueTopics,
  updateTopic,
  upsertNewsItem,
} from "../../src/memory/web_news.ts";
import type { User } from "../../src/auth/users.ts";
import type { Project } from "../../src/memory/projects.ts";

let tmp: string;

function userRow(id: string, role: "admin" | "user"): User {
  return {
    id,
    username: id,
    role,
    mustChangePassword: false,
    displayName: null,
    email: null,
    createdAt: 0,
    updatedAt: 0,
    expandThinkBubbles: false,
    expandToolBubbles: false,
    preferredLanguage: null,
  };
}

async function setup() {
  tmp = mkdtempSync(join(tmpdir(), "bunny-news-"));
  const db = await openDb(join(tmp, "test.sqlite"));
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

describe("createTopic", () => {
  test("creates with defaults and project scoping", async () => {
    const { db } = await setup();
    const t = createTopic(db, {
      project: "alpha",
      name: "AI news",
      agent: "researcher",
      updateCron: "0 */6 * * *",
      nextUpdateAt: 1000,
      createdBy: "owner",
    });
    expect(t.id).toBeGreaterThan(0);
    expect(t.project).toBe("alpha");
    expect(t.name).toBe("AI news");
    expect(t.terms).toEqual([]);
    expect(t.enabled).toBe(true);
    expect(t.runStatus).toBe("idle");
    expect(t.maxItemsPerRun).toBe(10);
    expect(t.alwaysRegenerateTerms).toBe(false);

    const listed = listTopics(db, "alpha");
    expect(listed).toHaveLength(1);
    expect(listTopics(db, "beta")).toHaveLength(0);
  });

  test("rejects duplicate (project, name)", async () => {
    const { db } = await setup();
    createTopic(db, {
      project: "alpha",
      name: "dup",
      agent: "a",
      updateCron: "* * * * *",
      nextUpdateAt: 0,
      createdBy: "owner",
    });
    expect(() =>
      createTopic(db, {
        project: "alpha",
        name: "dup",
        agent: "a",
        updateCron: "* * * * *",
        nextUpdateAt: 0,
        createdBy: "owner",
      }),
    ).toThrow();
  });
});

describe("claimTopicForRun", () => {
  test("first caller wins the race", async () => {
    const { db } = await setup();
    const t = createTopic(db, {
      project: "alpha",
      name: "races",
      agent: "a",
      updateCron: "* * * * *",
      nextUpdateAt: 0,
      createdBy: "owner",
    });
    expect(claimTopicForRun(db, t.id)).toBe(true);
    expect(claimTopicForRun(db, t.id)).toBe(false);
    releaseTopic(db, t.id, { status: "ok", nextUpdateAt: 5_000 });
    expect(getTopic(db, t.id)!.runStatus).toBe("idle");
    expect(claimTopicForRun(db, t.id)).toBe(true);
  });
});

describe("releaseTopic", () => {
  test("stores status, error, and optional terms + nextRenew", async () => {
    const { db } = await setup();
    const t = createTopic(db, {
      project: "alpha",
      name: "rel",
      agent: "a",
      updateCron: "* * * * *",
      renewTermsCron: "0 0 * * 0",
      nextUpdateAt: 0,
      nextRenewTermsAt: 1_000,
      createdBy: "owner",
    });
    claimTopicForRun(db, t.id);
    releaseTopic(db, t.id, {
      status: "ok",
      nextUpdateAt: 10_000,
      nextRenewTermsAt: 20_000,
      terms: ["a", "b"],
      sessionId: "sess-1",
    });
    const fresh = getTopic(db, t.id)!;
    expect(fresh.runStatus).toBe("idle");
    expect(fresh.lastRunStatus).toBe("ok");
    expect(fresh.terms).toEqual(["a", "b"]);
    expect(fresh.nextUpdateAt).toBe(10_000);
    expect(fresh.nextRenewTermsAt).toBe(20_000);
    expect(fresh.lastSessionId).toBe("sess-1");
  });

  test("does not overwrite next_renew_terms_at when caller omits it", async () => {
    const { db } = await setup();
    const t = createTopic(db, {
      project: "alpha",
      name: "keep",
      agent: "a",
      updateCron: "* * * * *",
      nextUpdateAt: 0,
      nextRenewTermsAt: 5_000,
      createdBy: "owner",
    });
    claimTopicForRun(db, t.id);
    releaseTopic(db, t.id, { status: "error", nextUpdateAt: 8_000 });
    const fresh = getTopic(db, t.id)!;
    expect(fresh.nextRenewTermsAt).toBe(5_000);
    expect(fresh.lastRunStatus).toBe("error");
  });
});

describe("selectDueTopics", () => {
  test("returns only enabled + idle rows with passed timestamps", async () => {
    const { db } = await setup();
    createTopic(db, {
      project: "alpha",
      name: "due-update",
      agent: "a",
      updateCron: "* * * * *",
      nextUpdateAt: 0,
      createdBy: "owner",
    });
    createTopic(db, {
      project: "alpha",
      name: "due-renew",
      agent: "a",
      terms: ["keep"],
      updateCron: "* * * * *",
      renewTermsCron: "0 0 * * 0",
      nextUpdateAt: 9_999_999,
      nextRenewTermsAt: 0,
      createdBy: "owner",
    });
    createTopic(db, {
      project: "alpha",
      name: "not-due",
      agent: "a",
      updateCron: "* * * * *",
      nextUpdateAt: 9_999_999,
      createdBy: "owner",
    });
    const disabled = createTopic(db, {
      project: "alpha",
      name: "disabled",
      agent: "a",
      updateCron: "* * * * *",
      nextUpdateAt: 0,
      enabled: false,
      createdBy: "owner",
    });
    expect(disabled.enabled).toBe(false);

    const due = selectDueTopics(db, 1_000);
    const names = due.map((d) => d.id).sort();
    expect(names).toHaveLength(2);
    expect(due.find((d) => d.updateDue)).toBeDefined();
    expect(due.find((d) => d.renewDue)).toBeDefined();
  });
});

describe("upsertNewsItem dedup", () => {
  test("same URL + title collapses via content_hash", async () => {
    const { db } = await setup();
    const t = createTopic(db, {
      project: "alpha",
      name: "feed",
      agent: "a",
      updateCron: "* * * * *",
      nextUpdateAt: 0,
      createdBy: "owner",
    });
    const first = upsertNewsItem(db, {
      topicId: t.id,
      project: "alpha",
      title: "Breaking: AI wins chess",
      url: "https://example.com/ai-wins",
      now: 100,
    });
    expect(first.inserted).toBe(true);
    expect(first.item.seenCount).toBe(1);

    const second = upsertNewsItem(db, {
      topicId: t.id,
      project: "alpha",
      title: "  BREAKING: AI Wins Chess! ",
      url: "https://example.com/ai-wins/?utm_source=spam",
      now: 200,
    });
    expect(second.inserted).toBe(false);
    expect(second.item.id).toBe(first.item.id);
    expect(second.item.seenCount).toBe(2);
    expect(second.item.lastSeenAt).toBe(200);
  });

  test("different topics with same URL are independent", async () => {
    const { db } = await setup();
    const a = createTopic(db, {
      project: "alpha",
      name: "one",
      agent: "a",
      updateCron: "* * * * *",
      nextUpdateAt: 0,
      createdBy: "owner",
    });
    const b = createTopic(db, {
      project: "alpha",
      name: "two",
      agent: "a",
      updateCron: "* * * * *",
      nextUpdateAt: 0,
      createdBy: "owner",
    });
    const r1 = upsertNewsItem(db, {
      topicId: a.id,
      project: "alpha",
      title: "Shared headline",
      url: "https://example.com/story",
    });
    const r2 = upsertNewsItem(db, {
      topicId: b.id,
      project: "alpha",
      title: "Shared headline",
      url: "https://example.com/story",
    });
    expect(r1.inserted).toBe(true);
    expect(r2.inserted).toBe(true);
    expect(r1.item.id).not.toBe(r2.item.id);
  });
});

describe("computeContentHash", () => {
  test("normalises casing, whitespace, tracking params, trailing slash", () => {
    const a = computeContentHash(
      "https://example.com/path/?utm_source=x",
      " Hello World ",
    );
    const b = computeContentHash("HTTPS://example.com/path", "hello world");
    expect(a).toBe(b);
  });
});

describe("listItemsForProject + listRecentItemsForTopic", () => {
  test("orders by publishedAt desc then firstSeenAt desc", async () => {
    const { db } = await setup();
    const t = createTopic(db, {
      project: "alpha",
      name: "feed",
      agent: "a",
      updateCron: "* * * * *",
      nextUpdateAt: 0,
      createdBy: "owner",
    });
    upsertNewsItem(db, {
      topicId: t.id,
      project: "alpha",
      title: "old",
      url: "https://example.com/a",
      publishedAt: 1_000,
      now: 1_000,
    });
    upsertNewsItem(db, {
      topicId: t.id,
      project: "alpha",
      title: "new",
      url: "https://example.com/b",
      publishedAt: 5_000,
      now: 2_000,
    });
    const all = listItemsForProject(db, "alpha");
    expect(all.map((i) => i.title)).toEqual(["new", "old"]);
    const recent = listRecentItemsForTopic(db, t.id, 10);
    expect(recent.map((i) => i.title)).toEqual(["new", "old"]);
  });

  test("topic delete cascades items", async () => {
    const { db } = await setup();
    const t = createTopic(db, {
      project: "alpha",
      name: "feed",
      agent: "a",
      updateCron: "* * * * *",
      nextUpdateAt: 0,
      createdBy: "owner",
    });
    upsertNewsItem(db, {
      topicId: t.id,
      project: "alpha",
      title: "hey",
      url: "https://example.com/x",
    });
    deleteTopic(db, t.id);
    expect(listItemsForProject(db, "alpha")).toHaveLength(0);
  });
});

describe("updateTopic", () => {
  test("patches fields and nulls renewTermsCron when empty", async () => {
    const { db } = await setup();
    const t = createTopic(db, {
      project: "alpha",
      name: "patchable",
      agent: "a",
      updateCron: "* * * * *",
      renewTermsCron: "0 0 * * 0",
      nextUpdateAt: 0,
      nextRenewTermsAt: 1,
      createdBy: "owner",
    });
    const updated = updateTopic(db, t.id, {
      renewTermsCron: "",
      terms: ["new-term"],
      maxItemsPerRun: 25,
    });
    expect(updated.renewTermsCron).toBeNull();
    expect(updated.terms).toEqual(["new-term"]);
    expect(updated.maxItemsPerRun).toBe(25);
  });
});

describe("canEditTopic", () => {
  test("admin / creator / owner can edit", async () => {
    const { db } = await setup();
    const t = createTopic(db, {
      project: "alpha",
      name: "perms",
      agent: "a",
      updateCron: "* * * * *",
      nextUpdateAt: 0,
      createdBy: "owner",
    });
    const proj = {
      name: "alpha",
      description: null,
      visibility: "public",
      languages: ["en"],
      defaultLanguage: "en",
      createdBy: "owner",
      createdAt: 0,
      updatedAt: 0,
    } as Project;
    expect(canEditTopic(userRow("owner", "admin"), t, proj)).toBe(true);
    expect(canEditTopic(userRow("other", "user"), t, proj)).toBe(false);
    expect(
      canEditTopic(userRow("owner", "user"), t, {
        ...proj,
        createdBy: "owner",
      }),
    ).toBe(true);
  });
});
