/**
 * Regression tests for the search/replace patch logic (web/src/lib/patchUtils.ts).
 */

import { test, expect } from "bun:test";
import { applyPatches, extractPatches, extractFullBlock } from "../../web/src/lib/patchUtils.ts";

// --- Tests ---

const SCRIPT = `const naam = "hello world";\nconsole.log(naam);\n`;

test("applyPatches — single patch applies correctly", () => {
  const result = applyPatches(SCRIPT, [
    { search: '"hello world"', replace: '"hello piet"' },
  ]);
  expect(result).toBe(`const naam = "hello piet";\nconsole.log(naam);\n`);
});

test("applyPatches — multiple patches applied in order", () => {
  const src = `const a = 1;\nconst b = 2;\nconst c = 3;\n`;
  const result = applyPatches(src, [
    { search: "const a = 1;", replace: "const a = 10;" },
    { search: "const b = 2;", replace: "const b = 20;" },
  ]);
  expect(result).toBe(`const a = 10;\nconst b = 20;\nconst c = 3;\n`);
});

test("applyPatches — returns null when search text not found", () => {
  const result = applyPatches(SCRIPT, [
    { search: '"does not exist"', replace: '"replacement"' },
  ]);
  expect(result).toBeNull();
});

test("applyPatches — returns null when any block fails, even if others would succeed", () => {
  const result = applyPatches(SCRIPT, [
    { search: '"hello world"', replace: '"hello piet"' },
    { search: "NOT PRESENT", replace: "x" },
  ]);
  expect(result).toBeNull();
});

test("extractPatches — parses single block", () => {
  const response = `I will change the greeting.\n<<<SEARCH\nhello world\n===\nhello piet\n>>>REPLACE\nDone.`;
  const patches = extractPatches(response);
  expect(patches).toHaveLength(1);
  expect(patches[0]).toEqual({ search: "hello world", replace: "hello piet" });
});

test("extractPatches — parses multiple blocks", () => {
  const response = [
    "Two changes:",
    "<<<SEARCH",
    'const naam = "hello world";',
    "===",
    'const naam = "hello piet";',
    ">>>REPLACE",
    "<<<SEARCH",
    "console.log(naam);",
    "===",
    "console.log(`Greeting: ${naam}`);",
    ">>>REPLACE",
  ].join("\n");
  const patches = extractPatches(response);
  expect(patches).toHaveLength(2);
  expect(patches[0]!.search).toBe('const naam = "hello world";');
  expect(patches[1]!.replace).toBe("console.log(`Greeting: ${naam}`);");
});

test("extractPatches — returns empty array when no blocks present", () => {
  expect(extractPatches("Just a plain text answer.")).toHaveLength(0);
  expect(extractPatches("")).toHaveLength(0);
});

test("extractFullBlock — extracts last fenced code block", () => {
  const response = "Here is the full script:\n```typescript\nconst x = 1;\n```";
  expect(extractFullBlock(response)).toBe("const x = 1;");
});

test("extractFullBlock — returns last block when multiple present", () => {
  const response = [
    "```typescript",
    "first block",
    "```",
    "Some explanation.",
    "```typescript",
    "second block",
    "```",
  ].join("\n");
  expect(extractFullBlock(response)).toBe("second block");
});

test("extractFullBlock — returns null when no code block", () => {
  expect(extractFullBlock("Just text")).toBeNull();
  expect(extractFullBlock("")).toBeNull();
});

test("patch preferred over full block when both present", () => {
  // Simulate the priority: if patches exist and apply, they win over full block
  const response = [
    "I made targeted changes:",
    "<<<SEARCH",
    '"hello world"',
    "===",
    '"hello piet"',
    ">>>REPLACE",
    "Or if you prefer the full file:",
    "```typescript",
    'const naam = "something else";',
    "console.log(naam);",
    "```",
  ].join("\n");

  const patches = extractPatches(response);
  expect(patches).toHaveLength(1);
  const patched = applyPatches(SCRIPT, patches);
  expect(patched).not.toBeNull();
  // Patch should be used — it only changes what it needs to
  expect(patched).toBe(`const naam = "hello piet";\nconsole.log(naam);\n`);
});
