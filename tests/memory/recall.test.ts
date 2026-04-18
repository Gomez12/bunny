/**
 * Tests for hybrid BM25 + vector recall (RRF merge).
 *
 * Since sqlite-vec is unavailable in CI (Bun bundles SQLite without
 * extension loading), we test:
 *  - BM25-only path (vector returns [])
 *  - RRF merge logic in isolation
 *  - hybridRecall integration (which degrades gracefully without vectors)
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/memory/db.ts";
import { insertMessage } from "../../src/memory/messages.ts";
import { searchBM25 } from "../../src/memory/bm25.ts";
import { hybridRecall } from "../../src/memory/recall.ts";
import type { EmbedConfig } from "../../src/config.ts";

let tmp: string;

async function setup() {
  tmp = mkdtempSync(join(tmpdir(), "bunny-recall-"));
  return openDb(join(tmp, "recall.sqlite"), 4);
}

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const mockEmbedCfg: EmbedConfig = {
  baseUrl: "http://localhost:9999/v1", // non-existent — embed() returns zero-vector
  apiKey: "",
  model: "text-embedding-3-small",
  dim: 4,
};

describe("searchBM25", () => {
  test("returns results ranked by relevance", async () => {
    const db = await setup();
    insertMessage(db, {
      sessionId: "s1",
      role: "user",
      content: "how to install bun runtime",
    });
    insertMessage(db, {
      sessionId: "s1",
      role: "assistant",
      content: "bun is a fast javascript runtime",
    });
    insertMessage(db, {
      sessionId: "s1",
      role: "user",
      content: "what is typescript?",
    });

    const results = searchBM25(db, "bun runtime", 5);
    expect(results.length).toBeGreaterThanOrEqual(1);
    // "bun runtime" should rank the first two messages higher.
    const contents = results.map((r) => r.content ?? "");
    expect(contents[0]).toMatch(/bun/i);
    db.close();
  });

  test("session filter restricts results", async () => {
    const db = await setup();
    insertMessage(db, {
      sessionId: "a",
      role: "user",
      content: "alpha bun runtime",
    });
    insertMessage(db, {
      sessionId: "b",
      role: "user",
      content: "beta bun runtime",
    });

    const results = searchBM25(db, "bun", 10, "a");
    expect(results.every((r) => r.sessionId === "a")).toBe(true);
    db.close();
  });
});

describe("hybridRecall", () => {
  test("returns messages relevant to the query (BM25 path since no vectors)", async () => {
    const db = await setup();
    insertMessage(db, {
      sessionId: "s1",
      role: "user",
      content: "I love using bun for TypeScript",
    });
    insertMessage(db, {
      sessionId: "s1",
      role: "user",
      content: "python is also great",
    });
    insertMessage(db, {
      sessionId: "s1",
      role: "user",
      content: "bun test is really fast",
    });

    const results = await hybridRecall(db, mockEmbedCfg, "bun TypeScript", 5);
    expect(results.length).toBeGreaterThanOrEqual(1);
    // Top result should contain "bun"
    expect(results[0]?.content).toMatch(/bun/i);
    db.close();
  });

  test("returns empty array when no messages exist", async () => {
    const db = await setup();
    const results = await hybridRecall(db, mockEmbedCfg, "anything", 5);
    expect(results).toHaveLength(0);
    db.close();
  });

  test("rrfScore is positive", async () => {
    const db = await setup();
    insertMessage(db, {
      sessionId: "s1",
      role: "user",
      content: "bunny is the best agent",
    });
    const results = await hybridRecall(db, mockEmbedCfg, "bunny agent", 5);
    for (const r of results) {
      expect(r.rrfScore).toBeGreaterThan(0);
    }
    db.close();
  });

  test("trimmed messages are excluded from BM25 + recall", async () => {
    const db = await setup();
    const pivot = insertMessage(db, {
      sessionId: "s1",
      role: "user",
      content: "keepable text",
    });
    insertMessage(db, {
      sessionId: "s1",
      role: "assistant",
      content: "trimmable trampoline payload",
    });
    // Sanity: both rows are recalled before trim.
    expect(searchBM25(db, "trampoline").length).toBe(1);
    const beforeTrim = await hybridRecall(db, mockEmbedCfg, "trampoline", 5);
    expect(beforeTrim.length).toBe(1);

    // Trim the assistant row away.
    const { trimSessionAfter } = await import("../../src/memory/messages.ts");
    trimSessionAfter(db, "s1", pivot);

    expect(searchBM25(db, "trampoline").length).toBe(0);
    const afterTrim = await hybridRecall(db, mockEmbedCfg, "trampoline", 5);
    expect(afterTrim.length).toBe(0);
    db.close();
  });
});
