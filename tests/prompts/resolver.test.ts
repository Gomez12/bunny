/**
 * Resolver fallback chain — project override → global override → registry
 * default. Uses a temp $BUNNY_HOME + process.chdir so both TOML files land in
 * an isolated sandbox.
 */

import { afterEach, beforeEach, test, expect } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePrompt } from "../../src/prompts/resolve.ts";
import { __clearGlobalPromptsCache } from "../../src/prompts/global_overrides.ts";
import { __clearProjectPromptsCache } from "../../src/memory/prompt_overrides.ts";
import { PROMPTS } from "../../src/prompts/registry.ts";

const ORIGINAL_HOME = process.env["BUNNY_HOME"];
const ORIGINAL_CWD = process.cwd();
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "bunny-prompts-"));
  process.env["BUNNY_HOME"] = tmp;
  process.chdir(tmp);
  __clearGlobalPromptsCache();
  __clearProjectPromptsCache();
});

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  if (ORIGINAL_HOME === undefined) delete process.env["BUNNY_HOME"];
  else process.env["BUNNY_HOME"] = ORIGINAL_HOME;
  rmSync(tmp, { recursive: true, force: true });
});

test("falls back to registry default when no overrides exist", () => {
  const text = resolvePrompt("kb.definition");
  expect(text).toBe(PROMPTS["kb.definition"]!.defaultText);
});

test("global override replaces the registry default", () => {
  writeFileSync(
    join(tmp, "bunny.config.toml"),
    `[prompts]\n"kb.definition" = "GLOBAL KB"\n`,
    "utf8",
  );
  expect(resolvePrompt("kb.definition")).toBe("GLOBAL KB");
});

test("project override wins over global override", () => {
  writeFileSync(
    join(tmp, "bunny.config.toml"),
    `[prompts]\n"kb.definition" = "GLOBAL KB"\n`,
    "utf8",
  );
  const projectDir = join(tmp, "projects", "alpha");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, "prompts.toml"),
    `[prompts]\n"kb.definition" = "PROJECT ALPHA KB"\n`,
    "utf8",
  );
  expect(resolvePrompt("kb.definition", { project: "alpha" })).toBe(
    "PROJECT ALPHA KB",
  );
  // Other projects still see the global override.
  expect(resolvePrompt("kb.definition", { project: "beta" })).toBe("GLOBAL KB");
});

test("project override falls through to registry default when key is missing", () => {
  const projectDir = join(tmp, "projects", "alpha");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, "prompts.toml"),
    `[prompts]\n"contact.edit" = "alpha contact"\n`,
    "utf8",
  );
  expect(resolvePrompt("kb.definition", { project: "alpha" })).toBe(
    PROMPTS["kb.definition"]!.defaultText,
  );
});

test("unknown keys throw", () => {
  expect(() => resolvePrompt("does.not.exist")).toThrow(
    /unknown prompt key/,
  );
});

test("malformed prompts.toml is non-fatal (falls through to global/default)", () => {
  writeFileSync(
    join(tmp, "bunny.config.toml"),
    `[prompts]\n"kb.definition" = "GLOBAL"\n`,
    "utf8",
  );
  const projectDir = join(tmp, "projects", "alpha");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, "prompts.toml"),
    `this is not valid toml ===`,
    "utf8",
  );
  expect(resolvePrompt("kb.definition", { project: "alpha" })).toBe("GLOBAL");
});

test("non-string values in TOML are silently dropped (fall through)", () => {
  writeFileSync(
    join(tmp, "bunny.config.toml"),
    `[prompts]\n"kb.definition" = 42\n`,
    "utf8",
  );
  expect(resolvePrompt("kb.definition")).toBe(
    PROMPTS["kb.definition"]!.defaultText,
  );
});
