import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb } from "../../src/memory/db.ts";
import { createBunnyQueue } from "../../src/queue/bunqueue.ts";
import { queryEvents } from "../../src/queue/events.ts";
import type { Database } from "bun:sqlite";

let tmp: string;
let db: Database;

function setup() {
  tmp = mkdtempSync(join(tmpdir(), "bunny-q-"));
  db = openDb(join(tmp, "q.sqlite"));
  return db;
}

afterEach(() => {
  closeDb();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("createBunnyQueue", () => {
  test("log() inserts an event into the events table", async () => {
    const db = setup();
    const q = createBunnyQueue(db);

    await q.log({ topic: "llm", kind: "request", sessionId: "s1", data: { prompt: "hello" } });

    // Give the queue worker a moment to process.
    await q.close();

    const events = queryEvents(db, { topic: "llm" });
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]?.topic).toBe("llm");
    expect(events[0]?.kind).toBe("request");
    expect(events[0]?.sessionId).toBe("s1");
    expect(JSON.parse(events[0]?.payloadJson ?? "{}")).toEqual({ prompt: "hello" });
  });

  test("multiple log() calls all reach the events table", async () => {
    const db = setup();
    const q = createBunnyQueue(db);

    await q.log({ topic: "llm", kind: "request" });
    await q.log({ topic: "tool", kind: "call" });
    await q.log({ topic: "memory", kind: "index" });

    await q.close();

    const all = queryEvents(db, {});
    expect(all.length).toBeGreaterThanOrEqual(3);

    const topics = all.map((e) => e.topic);
    expect(topics).toContain("llm");
    expect(topics).toContain("tool");
    expect(topics).toContain("memory");
  });

  test("error field is persisted", async () => {
    const db = setup();
    const q = createBunnyQueue(db);

    await q.log({ topic: "llm", kind: "response", error: "timeout" });

    await q.close();

    const events = queryEvents(db, { topic: "llm" });
    expect(events[0]?.error).toBe("timeout");
  });
});
