import { describe, expect, test } from "bun:test";
import { buildSystemMessage } from "../../src/agent/prompt.ts";

describe("buildSystemMessage memory injection", () => {
  test("renders nothing when all three memory inputs are empty", () => {
    const msg = buildSystemMessage({});
    expect(msg.content).not.toContain("Persistent context");
  });

  test("renders only the soul section when soul is non-empty and the rest is blank", () => {
    const msg = buildSystemMessage({
      userSoul: "Prefers terse Dutch replies.",
      userDisplay: "Christiaan",
      project: "alpha",
    });
    expect(msg.content).toContain("## Persistent context");
    expect(msg.content).toContain("About Christiaan");
    expect(msg.content).toContain("Prefers terse Dutch replies.");
    expect(msg.content).not.toContain(
      "What you know about Christiaan in project",
    );
    expect(msg.content).not.toContain("accumulated notes");
  });

  test("renders all three sections when all three bodies are non-empty", () => {
    const msg = buildSystemMessage({
      userSoul: "S",
      userMemory: "M",
      agentProjectMemory: "A",
      userDisplay: "Alice",
      project: "alpha",
    });
    const c = msg.content!;
    expect(c).toContain("About Alice");
    expect(c).toContain("project 'alpha'");
    expect(c).toContain("accumulated notes for project 'alpha'");
  });

  test("falls back to 'the user' when no display name is supplied", () => {
    const msg = buildSystemMessage({ userSoul: "x" });
    expect(msg.content).toContain("About the user");
  });

  test("trims whitespace-only inputs back to empty", () => {
    const msg = buildSystemMessage({
      userSoul: "   ",
      userMemory: "\n\n",
      agentProjectMemory: " ",
    });
    expect(msg.content).not.toContain("Persistent context");
  });

  test("memory section sits between any agent header and the recall block", () => {
    const msg = buildSystemMessage({
      baseSystem: "BASE",
      userSoul: "soul-text",
      userDisplay: "Alice",
      project: "alpha",
      recall: [
        { sessionId: "s-1", messageId: 1, content: "recall-fact" } as never,
      ],
    });
    const c = msg.content!;
    expect(c.indexOf("Persistent context")).toBeGreaterThan(c.indexOf("BASE"));
    expect(c.indexOf("Relevant past context")).toBeGreaterThan(
      c.indexOf("Persistent context"),
    );
  });
});
