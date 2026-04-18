import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/memory/db.ts";
import {
  ensureSeedUsers,
  getSystemUserId,
  SYSTEM_USERNAME,
} from "../../src/auth/seed.ts";
import { countUsers, getUserByUsername } from "../../src/auth/users.ts";

let tmp: string;
afterEach(() => tmp && rmSync(tmp, { recursive: true, force: true }));

async function newDb() {
  tmp = mkdtempSync(join(tmpdir(), "bunny-seed-"));
  return openDb(join(tmp, "test.sqlite"));
}

const cfg = {
  defaultAdminUsername: "admin",
  defaultAdminPassword: "change-me",
  sessionTtlHours: 1,
};

describe("seed users", () => {
  test("seeds admin when empty and sets must_change_pw", async () => {
    const db = await newDb();
    await ensureSeedUsers(db, cfg);
    const admin = getUserByUsername(db, "admin")!;
    expect(admin.role).toBe("admin");
    expect(admin.mustChangePassword).toBe(true);
    db.close();
  });

  test("system user is always created", async () => {
    const db = await newDb();
    await ensureSeedUsers(db, cfg);
    const sys = getUserByUsername(db, SYSTEM_USERNAME)!;
    expect(sys.role).toBe("user");
    expect(getSystemUserId(db)).toBe(sys.id);
    db.close();
  });

  test("does not re-seed admin when users already exist", async () => {
    const db = await newDb();
    await ensureSeedUsers(db, cfg);
    const first = countUsers(db);
    await ensureSeedUsers(db, cfg);
    expect(countUsers(db)).toBe(first);
    db.close();
  });
});
