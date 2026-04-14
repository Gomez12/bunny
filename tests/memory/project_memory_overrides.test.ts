/**
 * Verifies that a project's on-disk systemprompt.toml can carry per-project
 * memory overrides (last_n, recall_k) and that they round-trip through
 * write/load without touching the prompt text.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureProjectDir,
  loadProjectAssets,
  projectDir,
  writeProjectSystemPrompt,
} from "../../src/memory/project_assets.ts";

let tmp: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "bunny-projmem-"));
  prevHome = process.env["BUNNY_HOME"];
  process.env["BUNNY_HOME"] = tmp;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env["BUNNY_HOME"];
  else process.env["BUNNY_HOME"] = prevHome;
  rmSync(tmp, { recursive: true, force: true });
});

describe("project memory overrides", () => {
  test("defaults to null (inherit globals) when the file is missing", () => {
    ensureProjectDir("demo");
    const assets = loadProjectAssets("demo");
    expect(assets.memory).toEqual({ lastN: null, recallK: null });
  });

  test("write + load round-trips the overrides", () => {
    ensureProjectDir("demo");
    writeProjectSystemPrompt(
      "demo",
      { prompt: "Be brief.", append: true },
      { lastN: 20, recallK: 4 },
    );
    const assets = loadProjectAssets("demo");
    expect(assets.memory).toEqual({ lastN: 20, recallK: 4 });
    expect(assets.systemPrompt.prompt.trim()).toBe("Be brief.");
  });

  test("writeProjectSystemPrompt without memory arg leaves existing overrides alone", () => {
    ensureProjectDir("demo");
    writeProjectSystemPrompt("demo", { prompt: "v1", append: true }, { lastN: 15, recallK: 6 });
    writeProjectSystemPrompt("demo", { prompt: "v2", append: true });
    const assets = loadProjectAssets("demo");
    expect(assets.systemPrompt.prompt.trim()).toBe("v2");
    expect(assets.memory).toEqual({ lastN: 15, recallK: 6 });
  });

  test("negative / non-numeric values are treated as null (inherit)", () => {
    ensureProjectDir("demo");
    const file = join(projectDir("demo"), "systemprompt.toml");
    // Hand-craft a TOML with garbage values so we exercise the parser's guards.
    writeFileSync(file, `append = true\nlast_n = -5\nrecall_k = "oops"\nprompt = """\nhi\n"""\n`);
    const assets = loadProjectAssets("demo");
    expect(assets.memory).toEqual({ lastN: null, recallK: null });
  });

  test("rendered TOML contains the overrides as real keys, not commented hints", () => {
    ensureProjectDir("demo");
    writeProjectSystemPrompt("demo", { prompt: "", append: true }, { lastN: 12, recallK: null });
    const raw = readFileSync(join(projectDir("demo"), "systemprompt.toml"), "utf8");
    expect(raw).toMatch(/^last_n = 12$/m);
    // recallK stays null so only the hint comment (no live key) should be present.
    expect(raw).not.toMatch(/^recall_k = /m);
  });
});
