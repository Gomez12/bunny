import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/memory/db.ts";
import { createUser } from "../../src/auth/users.ts";
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  validateApiKey,
} from "../../src/auth/apikeys.ts";

let tmp: string;
afterEach(() => tmp && rmSync(tmp, { recursive: true, force: true }));

async function newDb() {
  tmp = mkdtempSync(join(tmpdir(), "bunny-apikey-"));
  return openDb(join(tmp, "test.sqlite"));
}

describe("api keys", () => {
  test("create + validate + revoke", async () => {
    const db = await newDb();
    const u = await createUser(db, { username: "a", password: "p" });
    const { meta, secret } = await createApiKey(db, u.id, "laptop");
    expect(secret.startsWith("bny_")).toBe(true);
    expect(meta.name).toBe("laptop");

    const match = await validateApiKey(db, secret);
    expect(match?.userId).toBe(u.id);

    const keys = listApiKeys(db, u.id);
    expect(keys.length).toBe(1);
    expect(keys[0]!.id).toBe(meta.id);

    expect(revokeApiKey(db, meta.id, u.id)).toBe(true);
    expect(await validateApiKey(db, secret)).toBeNull();
    db.close();
  });

  test("expired keys reject", async () => {
    const db = await newDb();
    const u = await createUser(db, { username: "b", password: "p" });
    const { meta, secret } = await createApiKey(
      db,
      u.id,
      "tmp",
      Date.now() - 1000,
    );
    expect(meta.expiresAt).not.toBeNull();
    expect(await validateApiKey(db, secret)).toBeNull();
    db.close();
  });

  test("unknown + malformed keys reject", async () => {
    const db = await newDb();
    expect(await validateApiKey(db, "")).toBeNull();
    expect(await validateApiKey(db, "nope")).toBeNull();
    expect(await validateApiKey(db, "bny_deadbeef_nothing")).toBeNull();
    db.close();
  });
});
