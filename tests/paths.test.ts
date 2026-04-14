import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { paths, resolveBunnyHome, resolveBunnyPath } from "../src/paths.ts";

const tmp = mkdtempSync(join(tmpdir(), "bunny-paths-"));

afterEach(() => {
  // No-op here; individual tests keep their dirs until suite teardown.
});

describe("resolveBunnyHome", () => {
  test("defaults to ./.bunny under cwd", () => {
    const home = resolveBunnyHome({}, tmp);
    expect(home).toBe(join(tmp, ".bunny"));
  });

  test("honours absolute BUNNY_HOME", () => {
    const override = join(tmp, "state");
    expect(resolveBunnyHome({ BUNNY_HOME: override }, tmp)).toBe(override);
  });

  test("resolves relative BUNNY_HOME against cwd", () => {
    const home = resolveBunnyHome({ BUNNY_HOME: "./custom" }, tmp);
    expect(home).toBe(join(tmp, "custom"));
  });

  test("ignores empty BUNNY_HOME", () => {
    expect(resolveBunnyHome({ BUNNY_HOME: "" }, tmp)).toBe(join(tmp, ".bunny"));
  });

  test("never touches HOME", () => {
    // Sanity check: setting HOME shouldn't affect the result.
    const before = resolveBunnyHome({}, tmp);
    const after = resolveBunnyHome({ HOME: "/nonexistent/somewhere" }, tmp);
    expect(after).toBe(before);
  });
});

describe("resolveBunnyPath", () => {
  test("joins segments under home", () => {
    process.env["BUNNY_HOME"] = join(tmp, "state2");
    try {
      expect(resolveBunnyPath("logs", "x.log")).toBe(join(tmp, "state2", "logs", "x.log"));
    } finally {
      delete process.env["BUNNY_HOME"];
    }
  });

  test("produces absolute paths", () => {
    expect(isAbsolute(resolveBunnyPath("db.sqlite"))).toBe(true);
  });
});

describe("paths helpers", () => {
  test("configFile sits next to cwd, not under BUNNY_HOME", () => {
    expect(paths.configFile(tmp)).toBe(join(tmp, "bunny.config.toml"));
  });
});

// Clean tempdir after the whole file runs.
process.on("beforeExit", () => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});
