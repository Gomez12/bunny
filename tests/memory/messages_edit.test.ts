import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/memory/db.ts";
import {
  editMessageContent,
  findPriorUserMessage,
  getMessageOwner,
  getMessagesBySession,
  insertMessage,
  trimSessionAfter,
} from "../../src/memory/messages.ts";
import { searchBM25 } from "../../src/memory/bm25.ts";

let tmp: string;

async function newDb() {
  tmp = mkdtempSync(join(tmpdir(), "bunny-msg-edit-"));
  return openDb(join(tmp, "test.sqlite"));
}

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("editMessageContent + trimSessionAfter", () => {
  test("editMessageContent rewrites content and stamps edited_at", async () => {
    const db = await newDb();
    const id = insertMessage(db, {
      sessionId: "s1",
      role: "user",
      content: "first version",
    });
    editMessageContent(db, id, "second version");
    const rows = getMessagesBySession(db, "s1");
    expect(rows[0]!.content).toBe("second version");
    expect(rows[0]!.editedAt).toBeGreaterThan(0);
    db.close();
  });

  test("trimSessionAfter soft-deletes everything after the pivot", async () => {
    const db = await newDb();
    const a = insertMessage(db, {
      sessionId: "s1",
      role: "user",
      content: "keep",
    });
    insertMessage(db, { sessionId: "s1", role: "assistant", content: "drop1" });
    insertMessage(db, { sessionId: "s1", role: "user", content: "drop2" });
    insertMessage(db, { sessionId: "s1", role: "assistant", content: "drop3" });

    const result = trimSessionAfter(db, "s1", a);
    expect(result.trimmedCount).toBe(3);

    const visible = getMessagesBySession(db, "s1");
    expect(visible.map((r) => r.content)).toEqual(["keep"]);
    db.close();
  });

  test("trimming removes rows from FTS so BM25 no longer matches them", async () => {
    const db = await newDb();
    const pivot = insertMessage(db, {
      sessionId: "s1",
      role: "user",
      content: "keep this content",
    });
    insertMessage(db, {
      sessionId: "s1",
      role: "assistant",
      content: "trimmable trampoline",
    });
    expect(searchBM25(db, "trampoline").length).toBe(1);
    trimSessionAfter(db, "s1", pivot);
    expect(searchBM25(db, "trampoline").length).toBe(0);
    db.close();
  });

  test("getMessageOwner returns null for trimmed rows", async () => {
    const db = await newDb();
    const pivot = insertMessage(db, {
      sessionId: "s1",
      role: "user",
      userId: "u1",
      content: "keep",
    });
    const trimmed = insertMessage(db, {
      sessionId: "s1",
      role: "assistant",
      userId: "u1",
      content: "drop",
    });
    trimSessionAfter(db, "s1", pivot);
    expect(getMessageOwner(db, pivot)?.userId).toBe("u1");
    expect(getMessageOwner(db, trimmed)).toBeNull();
    db.close();
  });

  test("findPriorUserMessage returns the latest user message before the pivot id", async () => {
    const db = await newDb();
    const u1 = insertMessage(db, {
      sessionId: "s1",
      role: "user",
      content: "earlier",
    });
    const a1 = insertMessage(db, {
      sessionId: "s1",
      role: "assistant",
      content: "answer to earlier",
    });
    const u2 = insertMessage(db, {
      sessionId: "s1",
      role: "user",
      content: "latest user prompt",
    });
    const a2 = insertMessage(db, {
      sessionId: "s1",
      role: "assistant",
      content: "answer to latest",
    });

    expect(findPriorUserMessage(db, "s1", a2)?.id).toBe(u2);
    expect(findPriorUserMessage(db, "s1", a1)?.id).toBe(u1);
    db.close();
  });
});
