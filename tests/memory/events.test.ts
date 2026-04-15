import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../../src/memory/db.ts";
import { listEventFacets, listEvents } from "../../src/memory/events.ts";

let tmp: string;
let db: Database;

function insert(
  db: Database,
  row: {
    ts: number;
    topic: string;
    kind: string;
    sessionId?: string | null;
    userId?: string | null;
    durationMs?: number | null;
    error?: string | null;
    payloadJson?: string | null;
  },
) {
  db.prepare(
    `INSERT INTO events (ts, topic, kind, session_id, payload_json, duration_ms, error, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.ts,
    row.topic,
    row.kind,
    row.sessionId ?? null,
    row.payloadJson ?? null,
    row.durationMs ?? null,
    row.error ?? null,
    row.userId ?? null,
  );
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "bunny-events-"));
  db = await openDb(join(tmp, "test.sqlite"));
  insert(db, { ts: 1000, topic: "llm", kind: "request", sessionId: "s1", userId: "u1", payloadJson: '{"foo":"bar"}' });
  insert(db, { ts: 2000, topic: "llm", kind: "response", sessionId: "s1", userId: "u1", durationMs: 42 });
  insert(db, { ts: 3000, topic: "tool", kind: "call", sessionId: "s1", userId: "u1", payloadJson: '{"name":"web_search"}' });
  insert(db, { ts: 4000, topic: "tool", kind: "result", sessionId: "s2", userId: "u2", error: "boom" });
  insert(db, { ts: 5000, topic: "memory", kind: "index", sessionId: "s2", userId: "u2" });
});

afterEach(() => {
  db.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("listEvents", () => {
  test("returns all rows ordered ts DESC with total", () => {
    const r = listEvents(db);
    expect(r.total).toBe(5);
    expect(r.items.map((e) => e.ts)).toEqual([5000, 4000, 3000, 2000, 1000]);
    const first = r.items[0]!;
    expect(first.topic).toBe("memory");
    expect(first.sessionId).toBe("s2");
    expect(first.userId).toBe("u2");
  });

  test("topic filter", () => {
    const r = listEvents(db, { topic: "llm" });
    expect(r.total).toBe(2);
    expect(r.items.every((e) => e.topic === "llm")).toBe(true);
  });

  test("kind filter combined with topic", () => {
    const r = listEvents(db, { topic: "tool", kind: "result" });
    expect(r.total).toBe(1);
    expect(r.items[0]!.error).toBe("boom");
  });

  test("errorsOnly filter", () => {
    const r = listEvents(db, { errorsOnly: true });
    expect(r.total).toBe(1);
    expect(r.items[0]!.error).toBe("boom");
  });

  test("session_id LIKE filter", () => {
    const r = listEvents(db, { sessionId: "s2" });
    expect(r.total).toBe(2);
    expect(r.items.every((e) => e.sessionId === "s2")).toBe(true);
  });

  test("user_id LIKE filter", () => {
    const r = listEvents(db, { userId: "u1" });
    expect(r.total).toBe(3);
  });

  test("date range", () => {
    const r = listEvents(db, { fromTs: 2000, toTs: 4000 });
    expect(r.total).toBe(3);
    expect(r.items.map((e) => e.ts)).toEqual([4000, 3000, 2000]);
  });

  test("payload LIKE search", () => {
    const r = listEvents(db, { q: "web_search" });
    expect(r.total).toBe(1);
    expect(r.items[0]!.kind).toBe("call");
  });

  test("limit + offset pagination, total stays correct", () => {
    const p1 = listEvents(db, { limit: 2, offset: 0 });
    expect(p1.total).toBe(5);
    expect(p1.items.map((e) => e.ts)).toEqual([5000, 4000]);
    const p2 = listEvents(db, { limit: 2, offset: 2 });
    expect(p2.items.map((e) => e.ts)).toEqual([3000, 2000]);
  });

  test("limit is clamped to 500", () => {
    const r = listEvents(db, { limit: 10_000 });
    expect(r.items.length).toBeLessThanOrEqual(500);
  });
});

describe("listEventFacets", () => {
  test("returns distinct sorted topics and kinds", () => {
    const f = listEventFacets(db);
    expect(f.topics).toEqual(["llm", "memory", "tool"]);
    expect(f.kinds).toEqual(["call", "index", "request", "response", "result"]);
  });
});
