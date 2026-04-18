import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/memory/db.ts";
import {
  insertMessage,
  getMessagesBySession,
} from "../../src/memory/messages.ts";

let tmp: string;

async function newDb() {
  tmp = mkdtempSync(join(tmpdir(), "bunny-tools-"));
  return openDb(join(tmp, "test.sqlite"));
}

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("tool call persistence", () => {
  test("stores channel='tool_call' with args + matches tool_result via toolCallId", async () => {
    const db = await newDb();
    insertMessage(db, { sessionId: "s1", role: "user", content: "ls" });
    insertMessage(db, {
      sessionId: "s1",
      role: "assistant",
      channel: "reasoning",
      content: "thinking",
    });
    insertMessage(db, {
      sessionId: "s1",
      role: "assistant",
      channel: "tool_call",
      content: '{"path":"."}',
      toolCallId: "call_42",
      toolName: "list_dir",
    });
    insertMessage(db, {
      sessionId: "s1",
      role: "tool",
      channel: "tool_result",
      content: "file1\nfile2",
      toolCallId: "call_42",
      toolName: "list_dir",
      ok: true,
    });

    const rows = getMessagesBySession(db, "s1");
    const call = rows.find((r) => r.channel === "tool_call")!;
    const result = rows.find((r) => r.channel === "tool_result")!;

    expect(call.content).toBe('{"path":"."}');
    expect(call.toolCallId).toBe("call_42");
    expect(result.toolCallId).toBe("call_42");
    expect(result.ok).toBe(true);
    db.close();
  });

  test("ok=false roundtrips correctly on failing tool", async () => {
    const db = await newDb();
    insertMessage(db, {
      sessionId: "s1",
      role: "tool",
      channel: "tool_result",
      content: "boom",
      toolCallId: "c1",
      toolName: "x",
      ok: false,
    });
    const rows = getMessagesBySession(db, "s1");
    expect(rows[0]!.ok).toBe(false);
    db.close();
  });

  test("migration adds `ok` column to an existing DB that lacks it", async () => {
    // Simulate a pre-migration database: create the table manually without `ok`.
    tmp = mkdtempSync(join(tmpdir(), "bunny-mig-"));
    const path = join(tmp, "legacy.sqlite");
    const { Database } = await import("bun:sqlite");
    const legacy = new Database(path, { create: true });
    legacy.run(`CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      role TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT 'content',
      content TEXT,
      tool_call_id TEXT,
      tool_name TEXT,
      provider_sig TEXT
    )`);
    legacy.close();

    // Re-open via openDb — migration should add the `ok` column.
    const db = await openDb(path);
    insertMessage(db, {
      sessionId: "s1",
      role: "tool",
      channel: "tool_result",
      content: "hi",
      ok: true,
    });
    const rows = getMessagesBySession(db, "s1");
    expect(rows[0]!.ok).toBe(true);
    db.close();
  });
});
