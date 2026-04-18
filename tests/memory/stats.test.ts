import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/memory/db.ts";
import {
  insertMessage,
  getMessagesBySession,
} from "../../src/memory/messages.ts";
import { getDashboardStats } from "../../src/memory/stats.ts";

let tmp: string;

async function newDb() {
  tmp = mkdtempSync(join(tmpdir(), "bunny-stats-"));
  return openDb(join(tmp, "test.sqlite"));
}

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("message stats", () => {
  test("duration + tokens round-trip through insert/select", async () => {
    const db = await newDb();
    insertMessage(db, {
      sessionId: "s1",
      role: "assistant",
      channel: "content",
      content: "hi",
      durationMs: 1234,
      promptTokens: 42,
      completionTokens: 17,
    });
    const rows = getMessagesBySession(db, "s1");
    expect(rows[0]!.durationMs).toBe(1234);
    expect(rows[0]!.promptTokens).toBe(42);
    expect(rows[0]!.completionTokens).toBe(17);
    db.close();
  });

  test("omitted stats read back as null", async () => {
    const db = await newDb();
    insertMessage(db, { sessionId: "s1", role: "user", content: "hi" });
    const r = getMessagesBySession(db, "s1")[0]!;
    expect(r.durationMs).toBeNull();
    expect(r.promptTokens).toBeNull();
    expect(r.completionTokens).toBeNull();
    db.close();
  });
});

describe("getDashboardStats", () => {
  test("returns zeroed KPIs on empty database", async () => {
    const db = await newDb();
    const data = getDashboardStats(db, { fromTs: 0, bucketMs: 86_400_000 });
    expect(data.kpi.totalMessages).toBe(0);
    expect(data.kpi.totalSessions).toBe(0);
    expect(data.kpi.totalPromptTokens).toBe(0);
    expect(data.kpi.totalCompletionTokens).toBe(0);
    expect(data.kpi.avgResponseMs).toBeNull();
    expect(data.activityOverTime).toEqual([]);
    expect(data.toolUsage).toEqual([]);
    expect(data.errorRate).toEqual({ total: 0, errors: 0 });
    db.close();
  });

  test("counts messages and sessions correctly", async () => {
    const db = await newDb();
    const now = Date.now();
    insertMessage(db, { sessionId: "s1", role: "user", content: "hi" });
    insertMessage(db, {
      sessionId: "s1",
      role: "assistant",
      content: "hello",
      durationMs: 500,
      promptTokens: 100,
      completionTokens: 50,
    });
    insertMessage(db, { sessionId: "s2", role: "user", content: "hi again" });

    const data = getDashboardStats(db, { fromTs: 0, bucketMs: 86_400_000 });
    expect(data.kpi.totalMessages).toBe(3);
    expect(data.kpi.totalSessions).toBe(2);
    expect(data.kpi.totalPromptTokens).toBe(100);
    expect(data.kpi.totalCompletionTokens).toBe(50);
    expect(data.kpi.avgResponseMs).toBe(500);
    db.close();
  });

  test("tool usage ranks by count descending", async () => {
    const db = await newDb();
    for (let i = 0; i < 5; i++) {
      db.run(
        `INSERT INTO messages (session_id, ts, role, channel, content, tool_name) VALUES ('s1', ?, 'tool', 'tool_call', '', 'read_file')`,
        [Date.now() + i],
      );
    }
    for (let i = 0; i < 3; i++) {
      db.run(
        `INSERT INTO messages (session_id, ts, role, channel, content, tool_name) VALUES ('s1', ?, 'tool', 'tool_call', '', 'web_search')`,
        [Date.now() + 10 + i],
      );
    }
    const data = getDashboardStats(db, { fromTs: 0, bucketMs: 86_400_000 });
    expect(data.toolUsage[0]!.name).toBe("read_file");
    expect(data.toolUsage[0]!.count).toBe(5);
    expect(data.toolUsage[1]!.name).toBe("web_search");
    db.close();
  });

  test("filters by userId when provided", async () => {
    const db = await newDb();
    insertMessage(db, {
      sessionId: "s1",
      role: "user",
      content: "a",
      userId: "u1",
    });
    insertMessage(db, {
      sessionId: "s1",
      role: "assistant",
      content: "b",
      userId: "u1",
      promptTokens: 100,
      completionTokens: 50,
    });
    insertMessage(db, {
      sessionId: "s2",
      role: "user",
      content: "c",
      userId: "u2",
    });

    const dataU1 = getDashboardStats(db, {
      fromTs: 0,
      bucketMs: 86_400_000,
      userId: "u1",
    });
    expect(dataU1.kpi.totalMessages).toBe(2);
    expect(dataU1.kpi.totalPromptTokens).toBe(100);

    const dataAll = getDashboardStats(db, { fromTs: 0, bucketMs: 86_400_000 });
    expect(dataAll.kpi.totalMessages).toBe(3);
    db.close();
  });

  test("error rate counts events with errors", async () => {
    const db = await newDb();
    const now = Date.now();
    db.run(
      `INSERT INTO events (ts, topic, kind) VALUES (?, 'llm', 'request')`,
      [now],
    );
    db.run(
      `INSERT INTO events (ts, topic, kind) VALUES (?, 'llm', 'response')`,
      [now + 1],
    );
    db.run(
      `INSERT INTO events (ts, topic, kind, error) VALUES (?, 'llm', 'request', 'timeout')`,
      [now + 2],
    );

    const data = getDashboardStats(db, { fromTs: 0, bucketMs: 86_400_000 });
    expect(data.errorRate.total).toBe(3);
    expect(data.errorRate.errors).toBe(1);
    db.close();
  });

  test("recent activity limited to 20 items", async () => {
    const db = await newDb();
    const now = Date.now();
    for (let i = 0; i < 25; i++) {
      db.run(
        `INSERT INTO events (ts, topic, kind) VALUES (?, 'llm', 'request')`,
        [now + i],
      );
    }
    const data = getDashboardStats(db, { fromTs: 0, bucketMs: 86_400_000 });
    expect(data.recentActivity.length).toBe(20);
    expect(data.recentActivity[0]!.ts).toBeGreaterThan(
      data.recentActivity[19]!.ts,
    );
    db.close();
  });
});
