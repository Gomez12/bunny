/**
 * Registry snapshot — asserts every `defaultText` string is byte-identical
 * to the hardcoded value the call site uses today. If someone edits a
 * `defaultText` (legitimate or accidental), this test tripwires the change
 * and forces a review before merge.
 *
 * We intentionally re-read the current literal from the source files rather
 * than duplicating the multi-kilobyte strings here — the point is that the
 * registry is the extraction of those literals, so both must agree.
 */

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROMPTS, PROMPT_KEYS, PROJECT_OVERRIDABLE_KEYS } from "../../src/prompts/registry.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), "utf8");
}

test("registry covers every known prompt key exactly once", () => {
  const keys = PROMPT_KEYS.sort();
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

test("project-overridable set is exactly the six content-flow prompts", () => {
  expect(PROJECT_OVERRIDABLE_KEYS.sort()).toEqual(
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

// ── Byte-exact snapshots vs the source files ─────────────────────────────────
//
// For each entry we grep the literal out of the call site and compare it
// against `defaultText`. This protects against silent drift when a future
// commit edits one side but forgets the other.

function extractBacktickString(src: string, anchor: string): string {
  const idx = src.indexOf(anchor);
  if (idx < 0) throw new Error(`anchor not found: ${anchor}`);
  // Find the opening backtick after the anchor, then walk forward to the
  // matching closing backtick. We don't support nested backticks inside
  // these templates (none of the prompts contain literal backticks outside
  // fenced code fences, which are written as `\\`\\`\\`).
  const start = src.indexOf("`", idx);
  if (start < 0) throw new Error(`no opening backtick after ${anchor}`);
  let i = start + 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "`") {
      return src.slice(start + 1, i);
    }
    i++;
  }
  throw new Error(`unterminated template literal at ${anchor}`);
}

function extractDoubleQuotedString(src: string, anchor: string): string {
  const idx = src.indexOf(anchor);
  if (idx < 0) throw new Error(`anchor not found: ${anchor}`);
  const start = src.indexOf('"', idx);
  if (start < 0) throw new Error(`no opening quote after ${anchor}`);
  let i = start + 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === '"') {
      const raw = src.slice(start + 1, i);
      // JSON-parse to resolve escape sequences.
      return JSON.parse(`"${raw}"`);
    }
    i++;
  }
  throw new Error(`unterminated string at ${anchor}`);
}

/**
 * Unescape a JS template literal body into the runtime string value. The
 * only escapes the prompts use are `\\` and `` \` `` (backtick inside the
 * template). Everything else is taken literally.
 */
function unescapeTemplate(literal: string): string {
  let out = "";
  for (let i = 0; i < literal.length; i++) {
    const ch = literal[i];
    if (ch === "\\" && i + 1 < literal.length) {
      const next = literal[i + 1]!;
      if (next === "`" || next === "\\" || next === "$") {
        out += next;
        i++;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

test("kb.definition defaultText matches src/server/kb_routes.ts literal", () => {
  const src = read("src/server/kb_routes.ts");
  const literal = extractBacktickString(src, "DEFINITION_SYSTEM_PROMPT");
  expect(unescapeTemplate(literal)).toBe(PROMPTS["kb.definition"]!.defaultText);
});

test("kb.illustration defaultText matches src/server/kb_routes.ts literal", () => {
  const src = read("src/server/kb_routes.ts");
  const literal = extractBacktickString(src, "ILLUSTRATION_SYSTEM_PROMPT");
  expect(unescapeTemplate(literal)).toBe(
    PROMPTS["kb.illustration"]!.defaultText,
  );
});

test("document.edit defaultText matches src/server/document_routes.ts literal", () => {
  const src = read("src/server/document_routes.ts");
  const literal = extractBacktickString(src, "EDIT_SYSTEM_PROMPT");
  expect(unescapeTemplate(literal)).toBe(
    PROMPTS["document.edit"]!.defaultText,
  );
});

test("whiteboard.edit defaultText matches src/server/whiteboard_routes.ts literal", () => {
  const src = read("src/server/whiteboard_routes.ts");
  const literal = extractBacktickString(src, "EDIT_SYSTEM_PROMPT");
  expect(unescapeTemplate(literal)).toBe(
    PROMPTS["whiteboard.edit"]!.defaultText,
  );
});

test("contact.edit defaultText matches src/server/contact_routes.ts literal", () => {
  const src = read("src/server/contact_routes.ts");
  const literal = extractBacktickString(src, "EDIT_SYSTEM_PROMPT");
  expect(unescapeTemplate(literal)).toBe(PROMPTS["contact.edit"]!.defaultText);
});

test("tools.ask_user.description matches src/tools/ask_user.ts literal", () => {
  const src = read("src/tools/ask_user.ts");
  const literal = extractDoubleQuotedString(src, "ASK_USER_DESCRIPTION");
  expect(literal).toBe(PROMPTS["tools.ask_user.description"]!.defaultText);
});

test("tools.call_agent.description matches src/tools/call_agent.ts literal", () => {
  const src = read("src/tools/call_agent.ts");
  const literal = extractDoubleQuotedString(src, "CALL_AGENT_DESCRIPTION");
  expect(literal).toBe(PROMPTS["tools.call_agent.description"]!.defaultText);
});

test("tools.activate_skill.description matches src/tools/activate_skill.ts literal", () => {
  const src = read("src/tools/activate_skill.ts");
  const literal = extractDoubleQuotedString(src, "ACTIVATE_SKILL_DESCRIPTION");
  expect(literal).toBe(
    PROMPTS["tools.activate_skill.description"]!.defaultText,
  );
});
