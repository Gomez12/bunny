/**
 * Registry snapshot — freezes the default text of every prompt as a
 * fixture file under `tests/prompts/fixtures/`. `defaultText` must match
 * the fixture byte-for-byte, so any accidental edit to the registry trips
 * a test before it reaches production.
 *
 * Regenerate the fixtures deliberately with:
 *   bun -e 'import { PROMPTS } from "./src/prompts/registry.ts";
 *           import { writeFileSync } from "node:fs";
 *           for (const [k, d] of Object.entries(PROMPTS)) {
 *             writeFileSync(
 *               "tests/prompts/fixtures/" + k.replace(/\\./g,"__") + ".txt",
 *               d.defaultText, "utf8",
 *             );
 *           }'
 * and review the diff before committing.
 */

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PROMPTS,
  PROMPT_KEYS,
  PROJECT_OVERRIDABLE_KEYS,
} from "../../src/prompts/registry.ts";

const FIXTURES = join(import.meta.dir, "fixtures");

function fixturePath(key: string): string {
  return join(FIXTURES, key.replace(/\./g, "__") + ".txt");
}

test("registry covers every known prompt key exactly once", () => {
  const keys = [...PROMPT_KEYS].sort();
  expect(new Set(keys).size).toBe(keys.length);
  expect(keys).toEqual(
    [
      "agent.ask_user_hint",
      "agent.peer_agents_hint",
      "agent.skill_catalog_hint",
      "contact.edit",
      "document.edit",
      "kb.definition",
      "kb.illustration",
      "tools.activate_skill.description",
      "tools.ask_user.description",
      "tools.call_agent.description",
      "web_news.fetch",
      "web_news.renew_terms",
      "whiteboard.edit",
    ].sort(),
  );
});

test("project-overridable set is exactly the seven content-flow prompts", () => {
  expect([...PROJECT_OVERRIDABLE_KEYS].sort()).toEqual(
    [
      "kb.definition",
      "kb.illustration",
      "document.edit",
      "whiteboard.edit",
      "contact.edit",
      "web_news.fetch",
      "web_news.renew_terms",
    ].sort(),
  );
});

test("every entry declares a non-empty defaultText and description", () => {
  for (const key of PROMPT_KEYS) {
    const def = PROMPTS[key]!;
    expect(def.defaultText.length).toBeGreaterThan(0);
    expect(def.description.length).toBeGreaterThan(0);
    expect(def.scope === "global" || def.scope === "projectOverridable").toBe(
      true,
    );
  }
});

test("defaultText matches frozen fixture for every prompt", () => {
  for (const key of PROMPT_KEYS) {
    const fixture = readFileSync(fixturePath(key), "utf8");
    expect(PROMPTS[key]!.defaultText).toBe(fixture);
  }
});
