import { describe, expect, test } from "bun:test";
import { resolveBubbleLabel } from "../../web/src/lib/messageLabel.ts";

describe("resolveBubbleLabel", () => {
  test("user row prefers displayName", () => {
    const r = resolveBubbleLabel({
      role: "user",
      author: null,
      displayName: "Christiaan",
      username: "cs",
      defaultAgent: "bunny",
    });
    expect(r).toEqual({ label: "Christiaan", kind: "user" });
  });

  test("user row falls back to username when displayName is empty", () => {
    const r = resolveBubbleLabel({
      role: "user",
      author: null,
      displayName: "   ",
      username: "cs",
      defaultAgent: "bunny",
    });
    expect(r).toEqual({ label: "cs", kind: "user" });
  });

  test("user row falls back to 'you' when both are empty", () => {
    const r = resolveBubbleLabel({
      role: "user",
      author: null,
      displayName: null,
      username: null,
      defaultAgent: "bunny",
    });
    expect(r).toEqual({ label: "you", kind: "user" });
  });

  test("assistant row shows @author when set", () => {
    const r = resolveBubbleLabel({
      role: "assistant",
      author: "mia",
      defaultAgent: "bunny",
    });
    expect(r).toEqual({ label: "@mia", kind: "agent" });
  });

  test("assistant row falls back to @default when author is null (legacy)", () => {
    const r = resolveBubbleLabel({
      role: "assistant",
      author: null,
      defaultAgent: "bunny",
    });
    expect(r).toEqual({ label: "@bunny", kind: "agent" });
  });

  test("tool / system rows pass through", () => {
    expect(resolveBubbleLabel({ role: "tool", defaultAgent: "bunny" })).toEqual(
      { label: "tool", kind: "tool" },
    );
    expect(
      resolveBubbleLabel({ role: "system", defaultAgent: "bunny" }),
    ).toEqual({ label: "system", kind: "system" });
  });
});
