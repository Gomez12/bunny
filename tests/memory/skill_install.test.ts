import { describe, expect, test } from "bun:test";
import { parseGitHubUrl } from "../../src/memory/skill_install.ts";

describe("parseGitHubUrl", () => {
  test("parses tree URL with branch and path", () => {
    const result = parseGitHubUrl("https://github.com/anthropics/skills/tree/main/skills/frontend-design");
    expect(result).toEqual({
      owner: "anthropics",
      repo: "skills",
      ref: "main",
      path: "skills/frontend-design",
    });
  });

  test("parses tree URL with nested path", () => {
    const result = parseGitHubUrl("https://github.com/org/repo/tree/develop/deep/nested/skill");
    expect(result).toEqual({
      owner: "org",
      repo: "repo",
      ref: "develop",
      path: "deep/nested/skill",
    });
  });

  test("parses simple owner/repo URL", () => {
    const result = parseGitHubUrl("https://github.com/owner/repo");
    expect(result).toEqual({
      owner: "owner",
      repo: "repo",
      ref: "main",
      path: "",
    });
  });

  test("parses blob URL", () => {
    const result = parseGitHubUrl("https://github.com/org/repo/blob/main/skills/test");
    expect(result).toEqual({
      owner: "org",
      repo: "repo",
      ref: "main",
      path: "skills/test",
    });
  });

  test("strips trailing slash", () => {
    const result = parseGitHubUrl("https://github.com/owner/repo/tree/main/skill/");
    expect(result.path).toBe("skill");
  });

  test("throws on non-GitHub URL", () => {
    expect(() => parseGitHubUrl("https://gitlab.com/owner/repo")).toThrow("not a GitHub URL");
  });

  test("throws on invalid URL", () => {
    expect(() => parseGitHubUrl("not-a-url")).toThrow("invalid URL");
  });

  test("throws on URL without owner/repo", () => {
    expect(() => parseGitHubUrl("https://github.com/only-owner")).toThrow("cannot extract");
  });
});
