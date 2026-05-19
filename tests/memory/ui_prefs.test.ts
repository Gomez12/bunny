import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/memory/db";
import type { Database } from "bun:sqlite";
import {
  parseGlobalUiPrefs,
  validateGlobalUiPrefsPatch,
  getGlobalUiPrefs,
  setGlobalUiPrefs,
} from "../../src/memory/ui_prefs";
import { createUser } from "../../src/auth/users";

let db: Database;

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), "bunny-ui-prefs-test-"));
  db = await openDb(join(dir, "test.db"));
});

describe("parseGlobalUiPrefs", () => {
  test("returns empty object for empty JSON", () => {
    expect(parseGlobalUiPrefs("{}")).toEqual({});
  });

  test("parses valid theme", () => {
    expect(parseGlobalUiPrefs('{"theme":"dark"}')).toEqual({ theme: "dark" });
    expect(parseGlobalUiPrefs('{"theme":"light"}')).toEqual({ theme: "light" });
  });

  test("ignores invalid theme values", () => {
    expect(parseGlobalUiPrefs('{"theme":"blue"}')).toEqual({});
  });

  test("parses all known keys", () => {
    const raw = JSON.stringify({
      theme: "light",
      activeProject: "my-project",
      activeTab: "chat",
      newsTemplate: "newspaper",
      defaultQuickChatProject: "scratch",
    });
    expect(parseGlobalUiPrefs(raw)).toEqual({
      theme: "light",
      activeProject: "my-project",
      activeTab: "chat",
      newsTemplate: "newspaper",
      defaultQuickChatProject: "scratch",
    });
  });

  test("drops empty / null defaultQuickChatProject", () => {
    expect(parseGlobalUiPrefs('{"defaultQuickChatProject":""}')).toEqual({});
    expect(parseGlobalUiPrefs('{"defaultQuickChatProject":null}')).toEqual({});
  });

  test("returns empty object for corrupt JSON", () => {
    expect(parseGlobalUiPrefs("not-json")).toEqual({});
  });
});

describe("validateGlobalUiPrefsPatch", () => {
  test("rejects non-object input", () => {
    expect(() => validateGlobalUiPrefsPatch("string")).toThrow("prefs must be an object");
    expect(() => validateGlobalUiPrefsPatch(null)).toThrow();
    expect(() => validateGlobalUiPrefsPatch([1, 2])).toThrow();
  });

  test("rejects unknown keys", () => {
    expect(() => validateGlobalUiPrefsPatch({ unknownKey: "value" })).toThrow("unknown pref keys");
  });

  test("rejects invalid theme", () => {
    expect(() => validateGlobalUiPrefsPatch({ theme: "blue" })).toThrow("theme must be");
  });

  test("rejects invalid newsTemplate", () => {
    expect(() => validateGlobalUiPrefsPatch({ newsTemplate: "grid" })).toThrow("newsTemplate must be");
  });

  test("accepts partial patch", () => {
    expect(validateGlobalUiPrefsPatch({ theme: "dark" })).toEqual({ theme: "dark" });
    expect(validateGlobalUiPrefsPatch({ activeProject: "proj" })).toEqual({ activeProject: "proj" });
  });

  test("accepts empty object", () => {
    expect(validateGlobalUiPrefsPatch({})).toEqual({});
  });

  test("accepts defaultQuickChatProject as string or null; coerces empty to null", () => {
    expect(validateGlobalUiPrefsPatch({ defaultQuickChatProject: "scratch" })).toEqual({
      defaultQuickChatProject: "scratch",
    });
    expect(validateGlobalUiPrefsPatch({ defaultQuickChatProject: null })).toEqual({
      defaultQuickChatProject: null,
    });
    expect(validateGlobalUiPrefsPatch({ defaultQuickChatProject: "" })).toEqual({
      defaultQuickChatProject: null,
    });
  });

  test("rejects defaultQuickChatProject of wrong type", () => {
    expect(() =>
      validateGlobalUiPrefsPatch({ defaultQuickChatProject: 7 }),
    ).toThrow("defaultQuickChatProject must be a string or null");
  });
});

describe("getGlobalUiPrefs / setGlobalUiPrefs", () => {
  test("returns empty prefs for new user (column defaults to '{}')", async () => {
    const user = await createUser(db, { username: "alice", password: "pw" });
    expect(getGlobalUiPrefs(db, user.id)).toEqual({});
  });

  test("setGlobalUiPrefs merges patch with existing prefs", async () => {
    const user = await createUser(db, { username: "bob", password: "pw" });
    setGlobalUiPrefs(db, user.id, { theme: "dark" });
    const after = setGlobalUiPrefs(db, user.id, { activeProject: "work" });
    expect(after).toEqual({ theme: "dark", activeProject: "work" });
  });

  test("setGlobalUiPrefs overwrites existing key on conflict", async () => {
    const user = await createUser(db, { username: "carol", password: "pw" });
    setGlobalUiPrefs(db, user.id, { theme: "dark" });
    const after = setGlobalUiPrefs(db, user.id, { theme: "light" });
    expect(after.theme).toBe("light");
  });

  test("getGlobalUiPrefs reflects persisted state", async () => {
    const user = await createUser(db, { username: "dave", password: "pw" });
    setGlobalUiPrefs(db, user.id, { theme: "dark", newsTemplate: "newspaper" });
    expect(getGlobalUiPrefs(db, user.id)).toEqual({ theme: "dark", newsTemplate: "newspaper" });
  });

  test("returns empty for missing user id", () => {
    expect(getGlobalUiPrefs(db, "no-such-id")).toEqual({});
  });
});
