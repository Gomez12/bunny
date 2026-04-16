import { describe, expect, test } from "bun:test";
import { makeActivateSkillTool } from "../../src/tools/activate_skill.ts";

describe("activate_skill tool", () => {
  const tool = makeActivateSkillTool({
    available: ["pdf-processing", "code-review"],
    loadInstructions: (name) => {
      if (name === "pdf-processing") {
        return {
          instructions: "# PDF Processing\n\nStep 1: extract text.",
          resources: ["scripts/extract.py", "references/spec.md"],
        };
      }
      if (name === "code-review") {
        return {
          instructions: "# Code Review\n\nCheck for bugs.",
          resources: [],
        };
      }
      throw new Error(`unknown skill: ${name}`);
    },
  });

  test("returns instructions for a valid skill", async () => {
    const result = await tool.handler({ name: "pdf-processing" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("# PDF Processing");
    expect(result.output).toContain("skill_content");
    expect(result.output).toContain("skill_resources");
    expect(result.output).toContain("scripts/extract.py");
  });

  test("returns instructions without resources section when none exist", async () => {
    const result = await tool.handler({ name: "code-review" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("# Code Review");
    expect(result.output).not.toContain("skill_resources");
  });

  test("rejects unavailable skill name", async () => {
    const result = await tool.handler({ name: "not-installed" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("not available");
  });

  test("rejects empty name", async () => {
    const result = await tool.handler({ name: "" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("required");
  });

  test("rejects missing name", async () => {
    const result = await tool.handler({});
    expect(result.ok).toBe(false);
    expect(result.output).toContain("required");
  });
});
