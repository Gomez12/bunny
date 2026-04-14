import { describe, expect, test } from "bun:test";
import { buildSystemMessage } from "../../src/agent/prompt.ts";

describe("buildSystemMessage with projectAssets", () => {
  test("appends project prompt when append=true", () => {
    const msg = buildSystemMessage({
      projectAssets: {
        systemPrompt: { prompt: "Talk like a pirate.", append: true },
        memory: { lastN: null, recallK: null },
      },
    });
    expect(msg.role).toBe("system");
    const content = msg.content ?? "";
    expect(content).toContain("You are Bunny");
    expect(content).toContain("Talk like a pirate.");
    expect(content.indexOf("You are Bunny")).toBeLessThan(content.indexOf("Talk like a pirate."));
  });

  test("replaces base prompt when append=false", () => {
    const msg = buildSystemMessage({
      projectAssets: {
        systemPrompt: { prompt: "ONLY pirate.", append: false },
        memory: { lastN: null, recallK: null },
      },
    });
    expect(msg.content).toContain("ONLY pirate.");
    expect(msg.content).not.toContain("You are Bunny");
  });

  test("empty project prompt falls back to base", () => {
    const msg = buildSystemMessage({
      projectAssets: {
        systemPrompt: { prompt: "", append: true },
        memory: { lastN: null, recallK: null },
      },
    });
    expect(msg.content).toContain("You are Bunny");
    expect(msg.content).not.toContain("Project instructions");
  });

  test("accepts legacy positional recall array", () => {
    const msg = buildSystemMessage([]);
    expect(msg.content).toContain("You are Bunny");
  });

  test("uses caller-provided baseSystem when present", () => {
    const msg = buildSystemMessage({ baseSystem: "You are Foo." });
    expect(msg.content).toBe("You are Foo.");
  });

  test("baseSystem + project append combine in order", () => {
    const msg = buildSystemMessage({
      baseSystem: "BASE",
      projectAssets: {
        systemPrompt: { prompt: "EXTRA", append: true },
        memory: { lastN: null, recallK: null },
      },
    });
    expect(msg.content).toBe("BASE\n\n## Project instructions\nEXTRA");
  });
});
