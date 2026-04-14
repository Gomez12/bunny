import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/memory/db.ts";
import { createUser } from "../../src/auth/users.ts";
import {
  issueSession,
  revokeSession,
  revokeUserSessions,
  sweepExpired,
  validateSession,
} from "../../src/auth/sessions.ts";

let tmp: string;
afterEach(() => tmp && rmSync(tmp, { recursive: true, force: true }));

async function newDb() {
  tmp = mkdtempSync(join(tmpdir(), "bunny-authsess-"));
  return openDb(join(tmp, "test.sqlite"));
}

describe("auth sessions", () => {
  test("issue + validate + revoke", async () => {
    const db = await newDb();
    const u = await createUser(db, { username: "x", password: "p" });
    const s = issueSession(db, u.id, 1);
    expect(s.token).toHaveLength(64);
    expect(validateSession(db, s.token)?.userId).toBe(u.id);
    revokeSession(db, s.token);
    expect(validateSession(db, s.token)).toBeNull();
    db.close();
  });

  test("expired sessions return null and are swept", async () => {
    const db = await newDb();
    const u = await createUser(db, { username: "y", password: "p" });
    const s = issueSession(db, u.id, 1);
    db.prepare(`UPDATE auth_sessions SET expires_at = ? WHERE token = ?`).run(
      Date.now() - 1000,
      s.token,
    );
    expect(validateSession(db, s.token)).toBeNull();

    // Re-insert a second expired row and sweep
    const s2 = issueSession(db, u.id, 1);
    db.prepare(`UPDATE auth_sessions SET expires_at = ? WHERE token = ?`).run(
      Date.now() - 1000,
      s2.token,
    );
    expect(sweepExpired(db)).toBeGreaterThanOrEqual(1);
    db.close();
  });

  test("revokeUserSessions clears all tokens for a user", async () => {
    const db = await newDb();
    const u = await createUser(db, { username: "z", password: "p" });
    issueSession(db, u.id);
    issueSession(db, u.id);
    revokeUserSessions(db, u.id);
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM auth_sessions`).get() as { n: number }).n;
    expect(n).toBe(0);
    db.close();
  });
});
