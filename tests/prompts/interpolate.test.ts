import { test, expect } from "bun:test";
import { interpolate, renderPrompt } from "../../src/prompts/resolve.ts";

test("substitutes {{name}} placeholders", () => {
  expect(interpolate("hello {{who}}", { who: "world" })).toBe("hello world");
});

test("supports multiple placeholders including repeats", () => {
  expect(interpolate("{{a}} and {{a}} and {{b}}", { a: "x", b: "y" })).toBe(
    "x and x and y",
  );
});

test("coerces non-string values via String()", () => {
  expect(interpolate("n={{n}}, ok={{ok}}", { n: 5, ok: true })).toBe(
    "n=5, ok=true",
  );
});

test("throws on unknown variable", () => {
  expect(() => interpolate("{{x}}", {})).toThrow(/missing variable "x"/);
});

test("leaves non-placeholder braces untouched", () => {
  expect(interpolate("{ literal } {{x}}", { x: "Y" })).toBe("{ literal } Y");
});

test("renderPrompt resolves + interpolates in one call", () => {
  const out = renderPrompt("agent.peer_agents_hint", { lines: "- @alice" });
  expect(out).toContain("## Other agents");
  expect(out).toContain("- @alice");
});
