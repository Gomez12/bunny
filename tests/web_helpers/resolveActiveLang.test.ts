/**
 * Tests for the pure frontend helper that picks the initial language tab
 * when an entity dialog opens. Exercises the fallback chain described in ADR
 * 0022 §5.
 */

import { describe, expect, test } from "bun:test";
import { resolveActiveLang } from "../../web/src/lib/resolveActiveLang.ts";

describe("resolveActiveLang", () => {
  test("returns user preferredLanguage when it's in project.languages", () => {
    const got = resolveActiveLang({
      user: { preferredLanguage: "en" },
      project: { languages: ["en", "nl"], defaultLanguage: "nl" },
      entity: { originalLang: "nl" },
    });
    expect(got).toBe("en");
  });

  test("falls back to project.defaultLanguage when user pref is absent", () => {
    const got = resolveActiveLang({
      user: { preferredLanguage: null },
      project: { languages: ["nl", "de"], defaultLanguage: "nl" },
      entity: { originalLang: "de" },
    });
    expect(got).toBe("nl");
  });

  test("falls back to project.defaultLanguage when user pref isn't supported", () => {
    const got = resolveActiveLang({
      user: { preferredLanguage: "en" },
      project: { languages: ["nl", "de"], defaultLanguage: "nl" },
      entity: { originalLang: "de" },
    });
    expect(got).toBe("nl");
  });

  test("falls back to entity.originalLang when project default isn't listed", () => {
    const got = resolveActiveLang({
      user: { preferredLanguage: null },
      project: { languages: ["nl", "de"], defaultLanguage: "fr" }, // broken default
      entity: { originalLang: "de" },
    });
    expect(got).toBe("de");
  });

  test("returns first project language as last resort", () => {
    const got = resolveActiveLang({
      user: { preferredLanguage: null },
      project: { languages: ["nl"], defaultLanguage: "xx" },
      entity: { originalLang: "xx" },
    });
    expect(got).toBe("nl");
  });

  test("never returns a language outside project.languages", () => {
    for (const langs of [["en"], ["en", "nl"], ["ja", "ko", "zh"]]) {
      for (const userPref of ["en", "nl", "de", null]) {
        const got = resolveActiveLang({
          user: { preferredLanguage: userPref },
          project: { languages: langs, defaultLanguage: langs[0]! },
          entity: { originalLang: "de" },
        });
        expect(langs.includes(got)).toBe(true);
      }
    }
  });

  test("handles undefined user (logged-out state) by falling back", () => {
    const got = resolveActiveLang({
      user: undefined,
      project: { languages: ["en", "nl"], defaultLanguage: "nl" },
      entity: { originalLang: "en" },
    });
    expect(got).toBe("nl");
  });
});
