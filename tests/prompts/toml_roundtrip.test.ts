/**
 * Low-level round-trip tests for the TOML readers/writers behind the prompt
 * override system. We exercise `setProjectPromptOverride` + reload without
 * going through HTTP so the TOML escaping + multiline handling is covered
 * directly.
 */

import { afterEach, beforeEach, test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadProjectPromptOverrides,
  setProjectPromptOverride,
  __clearProjectPromptsCache,
} from "../../src/memory/prompt_overrides.ts";
import { ensureProjectDir } from "../../src/memory/project_assets.ts";
import {
  loadGlobalPromptOverrides,
  setGlobalPromptOverride,
  __clearGlobalPromptsCache,
} from "../../src/prompts/global_overrides.ts";

const ORIGINAL_HOME = process.env["BUNNY_HOME"];
const ORIGINAL_CWD = process.cwd();
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "bunny-prompts-toml-"));
  process.env["BUNNY_HOME"] = tmp;
  process.chdir(tmp);
  __clearProjectPromptsCache();
  __clearGlobalPromptsCache();
});

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  if (ORIGINAL_HOME === undefined) delete process.env["BUNNY_HOME"];
  else process.env["BUNNY_HOME"] = ORIGINAL_HOME;
  rmSync(tmp, { recursive: true, force: true });
});

test("project prompts.toml round-trips a single-line override", () => {
  ensureProjectDir("alpha");
  setProjectPromptOverride("alpha", "contact.edit", "Short note.");
  expect(loadProjectPromptOverrides("alpha")).toEqual({
    "contact.edit": "Short note.",
  });
});

test("project prompts.toml round-trips a multi-line override with backticks", () => {
  ensureProjectDir("alpha");
  const body = "Line 1\nLine 2\n```json\n{\"x\": 1}\n```\nDone";
  setProjectPromptOverride("alpha", "kb.definition", body);
  __clearProjectPromptsCache();
  expect(loadProjectPromptOverrides("alpha")).toEqual({
    "kb.definition": body,
  });
});

test("project prompts.toml round-trips an override with triple-quote sequence", () => {
  ensureProjectDir("alpha");
  const body = 'A """ literal triple quote in the body.';
  setProjectPromptOverride("alpha", "contact.edit", body);
  __clearProjectPromptsCache();
  expect(loadProjectPromptOverrides("alpha")).toEqual({
    "contact.edit": body,
  });
});

test("setting text=null removes the key without nuking the file", () => {
  ensureProjectDir("alpha");
  setProjectPromptOverride("alpha", "kb.definition", "A");
  setProjectPromptOverride("alpha", "contact.edit", "B");
  setProjectPromptOverride("alpha", "kb.definition", null);
  expect(loadProjectPromptOverrides("alpha")).toEqual({ "contact.edit": "B" });
});

test("loader returns {} for a project with no prompts.toml", () => {
  ensureProjectDir("beta");
  expect(loadProjectPromptOverrides("beta")).toEqual({});
});

test("loader tolerates malformed TOML by returning {}", () => {
  ensureProjectDir("alpha");
  Bun.write(
    join(tmp, "projects", "alpha", "prompts.toml"),
    "this is not = valid ===\n",
  );
  expect(loadProjectPromptOverrides("alpha")).toEqual({});
});

test("global [prompts] write creates config file when missing", () => {
  const cfg = join(tmp, "bunny.config.toml");
  expect(existsSync(cfg)).toBe(false);
  setGlobalPromptOverride("kb.definition", "hello");
  expect(existsSync(cfg)).toBe(true);
  expect(loadGlobalPromptOverrides()).toEqual({ "kb.definition": "hello" });
});

test("global [prompts] write preserves other top-level blocks", () => {
  Bun.write(
    join(tmp, "bunny.config.toml"),
    `[llm]\nmodel = "m1"\nbase_url = "https://x"\n\n[memory]\nrecall_k = 8\n`,
  );
  setGlobalPromptOverride("kb.definition", "hello");
  const text = readFileSync(join(tmp, "bunny.config.toml"), "utf8");
  expect(text).toContain("[llm]");
  expect(text).toContain('model = "m1"');
  expect(text).toContain('base_url = "https://x"');
  expect(text).toContain("[memory]");
  expect(text).toContain("recall_k = 8");
  expect(text).toContain("[prompts]");
  expect(text).toContain('"kb.definition"');
});

test("global [prompts] delete preserves other keys + blocks", () => {
  setGlobalPromptOverride("kb.definition", "a");
  setGlobalPromptOverride("contact.edit", "b");
  setGlobalPromptOverride("kb.definition", null);
  expect(loadGlobalPromptOverrides()).toEqual({ "contact.edit": "b" });
});
