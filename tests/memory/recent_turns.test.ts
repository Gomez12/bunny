/**
 * Unit tests for `getRecentTurns` — the short-term history slice that the
 * agent loop replays verbatim in every request.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../../src/memory/db.ts";
import { insertMessage, getRecentTurns } from "../../src/memory/messages.ts";

let tmp: string;
let db: Database;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "bunny-recent-"));
  db = await openDb(join(tmp, "t.sqlite"));
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("getRecentTurns", () => {
  test("returns user + assistant content in chronological order", () => {
    const s = "s1";
    insertMessage(db, { sessionId: s, role: "user", content: "hi" });
    insertMessage(db, {
      sessionId: s,
      role: "assistant",
      channel: "reasoning",
      content: "thinking...",
    });
    insertMessage(db, { sessionId: s, role: "assistant", content: "hello" });
    insertMessage(db, { sessionId: s, role: "user", content: "how are you" });

    const turns = getRecentTurns(db, s, 10);
    expect(turns.map((t) => `${t.role}:${t.content}`)).toEqual([
      "user:hi",
      "assistant:hello",
      "user:how are you",
    ]);
  });

  test("skips tool_call / tool_result / reasoning rows", () => {
    const s = "s2";
    insertMessage(db, { sessionId: s, role: "user", content: "ls" });
    insertMessage(db, {
      sessionId: s,
      role: "assistant",
      channel: "tool_call",
      content: '{"path":"."}',
      toolCallId: "c1",
      toolName: "read_file",
    });
    insertMessage(db, {
      sessionId: s,
      role: "tool",
      channel: "tool_result",
      content: "README.md",
      toolCallId: "c1",
    });
    insertMessage(db, {
      sessionId: s,
      role: "assistant",
      content: "found README",
    });

    const turns = getRecentTurns(db, s, 10);
    expect(turns).toHaveLength(2);
    expect(
      turns.every((t) => t.role === "user" || t.role === "assistant"),
    ).toBe(true);
  });

  test("honours the limit and keeps the most recent slice", () => {
    const s = "s3";
    for (let i = 0; i < 6; i++) {
      insertMessage(db, { sessionId: s, role: "user", content: `q${i}` });
      insertMessage(db, { sessionId: s, role: "assistant", content: `a${i}` });
    }
    const turns = getRecentTurns(db, s, 4);
    expect(turns.map((t) => t.content)).toEqual(["q4", "a4", "q5", "a5"]);
  });

  test("limit <= 0 yields empty array", () => {
    insertMessage(db, { sessionId: "s4", role: "user", content: "x" });
    expect(getRecentTurns(db, "s4", 0)).toEqual([]);
  });

  test("does not leak messages from other sessions", () => {
    insertMessage(db, { sessionId: "a", role: "user", content: "hello-a" });
    insertMessage(db, { sessionId: "b", role: "user", content: "hello-b" });
    const turns = getRecentTurns(db, "a", 10);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.content).toBe("hello-a");
  });
});
