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

describe("buildSystemMessage with agentAssets", () => {
  test("agent identity is always injected, even with empty prompt", () => {
    const msg = buildSystemMessage({
      agentName: "bob",
      agentDescription: "grappenmaker",
      agentAssets: {
        systemPrompt: { prompt: "", append: false },
        memory: { lastN: null, recallK: null },
        tools: undefined,
        allowedSubagents: [],
      },
    });
    expect(msg.content).toContain('"bob"');
    expect(msg.content).toContain("Stay in character");
    expect(msg.content).toContain("grappenmaker");
    // The default assistant preamble must NOT leak through.
    expect(msg.content).not.toContain("You are Bunny");
  });

  test("agent prompt is concatenated after the identity header", () => {
    const msg = buildSystemMessage({
      agentName: "bob",
      agentAssets: {
        systemPrompt: { prompt: "Spreek alleen Nederlands.", append: false },
        memory: { lastN: null, recallK: null },
        tools: undefined,
        allowedSubagents: [],
      },
    });
    expect(msg.content).toContain('"bob"');
    expect(msg.content).toContain("Spreek alleen Nederlands.");
    const idx = msg.content!.indexOf('"bob"');
    const idx2 = msg.content!.indexOf("Spreek alleen Nederlands.");
    expect(idx).toBeLessThan(idx2);
  });

  test("append=true layers agent on top of the project stack", () => {
    const msg = buildSystemMessage({
      baseSystem: "BASE",
      projectAssets: {
        systemPrompt: { prompt: "PROJ", append: true },
        memory: { lastN: null, recallK: null },
      },
      agentName: "ada",
      agentAssets: {
        systemPrompt: { prompt: "AGENT", append: true },
        memory: { lastN: null, recallK: null },
        tools: undefined,
        allowedSubagents: [],
      },
    });
    expect(msg.content).toContain("BASE");
    expect(msg.content).toContain("## Project instructions\nPROJ");
    expect(msg.content).toContain("## Agent instructions");
    expect(msg.content).toContain("AGENT");
  });

  test("knows_other_agents peers are listed only for the current agent", () => {
    const msg = buildSystemMessage({
      agentName: "ada",
      agentAssets: {
        systemPrompt: { prompt: "", append: false },
        memory: { lastN: null, recallK: null },
        tools: undefined,
        allowedSubagents: [],
      },
      otherAgents: [
        { name: "ada", description: "self" },
        { name: "bob", description: "helper" },
      ],
    });
    expect(msg.content).toContain("## Other agents");
    expect(msg.content).toContain("@bob");
    expect(msg.content).not.toContain("@ada");
  });
});
