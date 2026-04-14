import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/memory/db.ts";
import {
  countUsers,
  createUser,
  deleteUser,
  getUserById,
  getUserByUsername,
  getUserPasswordHash,
  listUsers,
  setPassword,
  updateUser,
} from "../../src/auth/users.ts";
import { verifyPassword } from "../../src/auth/password.ts";

let tmp: string;
afterEach(() => tmp && rmSync(tmp, { recursive: true, force: true }));

async function newDb() {
  tmp = mkdtempSync(join(tmpdir(), "bunny-users-"));
  return openDb(join(tmp, "test.sqlite"));
}

describe("users", () => {
  test("create + hash + verify roundtrip", async () => {
    const db = await newDb();
    const u = await createUser(db, { username: "alice", password: "secret123", role: "admin" });
    expect(u.role).toBe("admin");
    const hash = getUserPasswordHash(db, u.id)!;
    expect(await verifyPassword("secret123", hash)).toBe(true);
    expect(await verifyPassword("wrong", hash)).toBe(false);
    db.close();
  });

  test("username uniqueness enforced", async () => {
    const db = await newDb();
    await createUser(db, { username: "bob", password: "pw" });
    await expect(createUser(db, { username: "bob", password: "pw2" })).rejects.toThrow();
    db.close();
  });

  test("list + search + delete", async () => {
    const db = await newDb();
    await createUser(db, { username: "alice", password: "x", displayName: "Alice" });
    await createUser(db, { username: "bob", password: "x", email: "bob@example.com" });
    await createUser(db, { username: "carol", password: "x" });

    expect(countUsers(db)).toBe(3);
    expect(listUsers(db).map((u) => u.username)).toEqual(["alice", "bob", "carol"]);
    expect(listUsers(db, { q: "ali" }).map((u) => u.username)).toEqual(["alice"]);
    expect(listUsers(db, { q: "example" }).map((u) => u.username)).toEqual(["bob"]);

    const bob = getUserByUsername(db, "bob")!;
    deleteUser(db, bob.id);
    expect(countUsers(db)).toBe(2);
    expect(getUserById(db, bob.id)).toBeNull();
    db.close();
  });

  test("updateUser + setPassword", async () => {
    const db = await newDb();
    const u = await createUser(db, { username: "d", password: "old" });
    const up = updateUser(db, u.id, { role: "admin", displayName: "Dee" })!;
    expect(up.role).toBe("admin");
    expect(up.displayName).toBe("Dee");

    await setPassword(db, u.id, "new-pw", true);
    const reload = getUserById(db, u.id)!;
    expect(reload.mustChangePassword).toBe(true);
    const hash = getUserPasswordHash(db, u.id)!;
    expect(await verifyPassword("new-pw", hash)).toBe(true);
    db.close();
  });
});
