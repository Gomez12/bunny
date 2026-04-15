import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/memory/db.ts";
import { insertMessage } from "../../src/memory/messages.ts";
import { searchBM25 } from "../../src/memory/bm25.ts";
import { listSessions } from "../../src/memory/sessions.ts";

let tmp: string;

async function newDb() {
  tmp = mkdtempSync(join(tmpdir(), "bunny-projscope-"));
  return openDb(join(tmp, "test.sqlite"));
}

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("BM25 scoped by project", () => {
  test("returns hits only from the requested project", async () => {
    const db = await newDb();
    insertMessage(db, { sessionId: "a1", role: "user", content: "unique phrase alpha", project: "alpha" });
    insertMessage(db, { sessionId: "b1", role: "user", content: "unique phrase beta", project: "beta" });

    const alphaHits = searchBM25(db, "unique phrase", 10, undefined, "alpha");
    expect(alphaHits.map((h) => h.sessionId)).toEqual(["a1"]);

    const betaHits = searchBM25(db, "unique phrase", 10, undefined, "beta");
    expect(betaHits.map((h) => h.sessionId)).toEqual(["b1"]);

    const anyHits = searchBM25(db, "unique phrase", 10);
    expect(anyHits.length).toBe(2);
    db.close();
  });

  test("legacy NULL-project rows surface only under 'general'", async () => {
    const db = await newDb();
    const now = Date.now();
    db.run(
      `INSERT INTO messages (session_id, ts, role, channel, content, project)
       VALUES ('legacy', ?, 'user', 'content', 'legacy phrase marker', NULL)`,
      [now],
    );
    const general = searchBM25(db, "legacy phrase marker", 10, undefined, "general");
    expect(general.length).toBe(1);
    const alpha = searchBM25(db, "legacy phrase marker", 10, undefined, "alpha");
    expect(alpha.length).toBe(0);
    db.close();
  });
});

describe("listSessions scoped by project", () => {
  test("filters sessions by project", async () => {
    const db = await newDb();
    insertMessage(db, { sessionId: "s-a", role: "user", content: "hello", project: "alpha" });
    insertMessage(db, { sessionId: "s-b", role: "user", content: "hello", project: "beta" });

    const alpha = listSessions(db, { project: "alpha" });
    expect(alpha.map((s) => s.sessionId)).toEqual(["s-a"]);
    expect(alpha[0]!.project).toBe("alpha");

    const beta = listSessions(db, { project: "beta" });
    expect(beta.map((s) => s.sessionId)).toEqual(["s-b"]);
    db.close();
  });
});
