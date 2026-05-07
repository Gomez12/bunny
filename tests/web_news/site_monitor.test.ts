/**
 * Tests for the 3-layer site monitor hash logic.
 * Focused on: hash persistence, topic type validation.
 */
import { describe, it, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/memory/db.ts";
import { createTopic, getTopic, updateSiteHashes } from "../../src/memory/web_news.ts";

// openDb seeds the 'general' project. We also need a test user for created_by FK.
async function makeDb() {
  const dir = mkdtempSync(join(tmpdir(), "bunny-site-mon-"));
  const db = await openDb(join(dir, "test.db"));
  const now = Date.now();
  db.run(
    `INSERT INTO users(id, username, password_hash, role, created_at, updated_at)
     VALUES ('tester', 'tester', 'x', 'admin', ?, ?)`,
    [now, now],
  );
  return db;
}

describe("updateSiteHashes", () => {
  it("persists html and md hashes", async () => {
    const db = await makeDb();
    const now = Date.now();
    const topic = createTopic(db, {
      project: "general",
      name: "monitor-test",
      agent: "bunny",
      updateCron: "0 * * * *",
      nextUpdateAt: now,
      createdBy: "tester",
      topicType: "site_monitor",
      siteUrl: "https://example.com",
    });

    expect(topic.lastHtmlHash).toBeNull();
    expect(topic.lastMdHash).toBeNull();

    updateSiteHashes(db, topic.id, "htmlhash123", "mdhash456");
    const updated = getTopic(db, topic.id)!;
    expect(updated.lastHtmlHash).toBe("htmlhash123");
    expect(updated.lastMdHash).toBe("mdhash456");
  });

  it("can clear hashes by setting null", async () => {
    const db = await makeDb();
    const now = Date.now();
    const topic = createTopic(db, {
      project: "general",
      name: "monitor-clear",
      agent: "bunny",
      updateCron: "0 * * * *",
      nextUpdateAt: now,
      createdBy: "tester",
      topicType: "site_monitor",
      siteUrl: "https://example.com",
    });
    updateSiteHashes(db, topic.id, "h1", "m1");
    updateSiteHashes(db, topic.id, null, null);
    const t = getTopic(db, topic.id)!;
    expect(t.lastHtmlHash).toBeNull();
    expect(t.lastMdHash).toBeNull();
  });
});

describe("site_monitor topic type", () => {
  it("createTopic validates siteUrl required", async () => {
    const db = await makeDb();
    expect(() =>
      createTopic(db, {
        project: "general",
        name: "no-url",
        agent: "bunny",
        updateCron: "0 * * * *",
        nextUpdateAt: Date.now(),
        createdBy: "tester",
        topicType: "site_monitor",
        // siteUrl intentionally missing
      }),
    ).toThrow("site_url is required");
  });

  it("createTopic stores siteUrl", async () => {
    const db = await makeDb();
    const topic = createTopic(db, {
      project: "general",
      name: "with-url",
      agent: "bunny",
      updateCron: "0 * * * *",
      nextUpdateAt: Date.now(),
      createdBy: "tester",
      topicType: "site_monitor",
      siteUrl: "https://example.com/news",
    });
    expect(topic.topicType).toBe("site_monitor");
    expect(topic.siteUrl).toBe("https://example.com/news");
  });
});

describe("rss_feed topic type", () => {
  it("createTopic validates feedUrl required", async () => {
    const db = await makeDb();
    expect(() =>
      createTopic(db, {
        project: "general",
        name: "no-feed",
        agent: "bunny",
        updateCron: "0 * * * *",
        nextUpdateAt: Date.now(),
        createdBy: "tester",
        topicType: "rss_feed",
        // feedUrl intentionally missing
      }),
    ).toThrow("feed_url is required");
  });

  it("createTopic stores feedUrl and normalises topicType", async () => {
    const db = await makeDb();
    const topic = createTopic(db, {
      project: "general",
      name: "with-feed",
      agent: "bunny",
      updateCron: "0 * * * *",
      nextUpdateAt: Date.now(),
      createdBy: "tester",
      topicType: "rss_feed",
      feedUrl: "https://example.com/feed.xml",
    });
    expect(topic.topicType).toBe("rss_feed");
    expect(topic.feedUrl).toBe("https://example.com/feed.xml");
  });

  it("keyword_search topic has null feedUrl and siteUrl", async () => {
    const db = await makeDb();
    const topic = createTopic(db, {
      project: "general",
      name: "keyword-topic",
      agent: "bunny",
      updateCron: "0 * * * *",
      nextUpdateAt: Date.now(),
      createdBy: "tester",
    });
    expect(topic.topicType).toBe("keyword_search");
    expect(topic.feedUrl).toBeNull();
    expect(topic.siteUrl).toBeNull();
  });
});
