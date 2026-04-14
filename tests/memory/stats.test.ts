import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/memory/db.ts";
import { insertMessage, getMessagesBySession } from "../../src/memory/messages.ts";

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
