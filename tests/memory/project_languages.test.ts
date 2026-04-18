/**
 * Tests for the per-project languages + default_language CRUD surface.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../../src/memory/db.ts";
import {
  createProject,
  getProject,
  updateProject,
  validateLanguages,
} from "../../src/memory/projects.ts";

let tmp: string;
let db: Database;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "bunny-project-langs-"));
  db = await openDb(join(tmp, "db.sqlite"));
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("validateLanguages", () => {
  test("accepts lowercase ISO 639-1 codes with a valid default", () => {
    expect(validateLanguages(["en", "nl"], "en")).toEqual({
      languages: ["en", "nl"],
      defaultLanguage: "en",
    });
  });

  test("normalises uppercase to lowercase", () => {
    expect(validateLanguages(["EN", "NL"], "EN")).toEqual({
      languages: ["en", "nl"],
      defaultLanguage: "en",
    });
  });

  test("deduplicates", () => {
    expect(validateLanguages(["en", "en", "nl"], "en").languages).toEqual([
      "en",
      "nl",
    ]);
  });

  test("rejects non-array languages", () => {
    expect(() => validateLanguages("en" as unknown, "en")).toThrow();
  });

  test("rejects empty languages", () => {
    expect(() => validateLanguages([], "en")).toThrow();
  });

  test("rejects non-2-letter codes", () => {
    expect(() => validateLanguages(["eng"], "eng")).toThrow();
    expect(() => validateLanguages(["e"], "e")).toThrow();
  });

  test("rejects default not in languages", () => {
    expect(() => validateLanguages(["en", "nl"], "de")).toThrow();
  });
});

describe("createProject + getProject with languages", () => {
  test("stores and round-trips languages + default_language", () => {
    createProject(db, {
      name: "alpha",
      languages: ["en", "nl"],
      defaultLanguage: "nl",
      createdBy: null,
    });
    const p = getProject(db, "alpha");
    expect(p?.languages).toEqual(["en", "nl"]);
    expect(p?.defaultLanguage).toBe("nl");
  });

  test("defaults to ['en']/'en' when languages omitted", () => {
    createProject(db, { name: "beta", createdBy: null });
    const p = getProject(db, "beta");
    expect(p?.languages).toEqual(["en"]);
    expect(p?.defaultLanguage).toBe("en");
  });

  test("rejects invalid languages at create time", () => {
    expect(() =>
      createProject(db, {
        name: "gamma",
        languages: ["xxx"],
        defaultLanguage: "xxx",
        createdBy: null,
      }),
    ).toThrow();
  });
});

describe("updateProject with languages", () => {
  beforeEach(() => {
    createProject(db, {
      name: "alpha",
      languages: ["en"],
      defaultLanguage: "en",
      createdBy: null,
    });
  });

  test("extending the language list validates and persists", () => {
    updateProject(db, "alpha", {
      languages: ["en", "nl"],
      defaultLanguage: "en",
    });
    const p = getProject(db, "alpha");
    expect(p?.languages).toEqual(["en", "nl"]);
  });

  test("changing default to a value outside languages throws", () => {
    expect(() =>
      updateProject(db, "alpha", { defaultLanguage: "de" }),
    ).toThrow();
  });

  test("language-list-only update keeps the previous default if still present", () => {
    updateProject(db, "alpha", { languages: ["en", "nl"] });
    const p = getProject(db, "alpha");
    expect(p?.defaultLanguage).toBe("en");
  });

  test("removing current default without passing a new one fails validation", () => {
    expect(() => updateProject(db, "alpha", { languages: ["nl"] })).toThrow();
  });
});
