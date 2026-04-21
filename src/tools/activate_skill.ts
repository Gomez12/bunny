/**
 * `activate_skill` tool — loads the full instructions of a named skill into
 * the conversation context. Implements tier 2 of the agentskills.io progressive
 * disclosure pattern: the system prompt contains the lightweight catalog
 * (name + description); this tool loads the full SKILL.md body on demand.
 *
 * Closure-bound per-run (same pattern as `call_agent`). Each `runAgent`
 * builds the handler via {@link makeActivateSkillTool} and splices it into
 * the per-run subset registry.
 */

import type { JsonSchemaObject } from "../llm/types.ts";
import type { ToolHandler, ToolResult } from "./registry.ts";
import { resolvePrompt } from "../prompts/resolve.ts";

export const ACTIVATE_SKILL_TOOL_NAME = "activate_skill";

export const ACTIVATE_SKILL_SCHEMA: JsonSchemaObject = {
  type: "object",
  properties: {
    name: {
      type: "string",
      description:
        "Skill name. Must be one of the available skills listed in the system prompt.",
    },
  },
  required: ["name"],
};

export interface ActivateSkillContext {
  available: readonly string[];
  loadInstructions: (name: string) => {
    instructions: string;
    resources: string[];
  };
}

export function makeActivateSkillTool(ctx: ActivateSkillContext): {
  name: string;
  description: string;
  parameters: JsonSchemaObject;
  handler: ToolHandler;
} {
  const handler: ToolHandler = async (args) => {
    const name = typeof args["name"] === "string" ? args["name"].trim() : "";
    if (!name) return errorResult("activate_skill: 'name' is required");
    if (!ctx.available.includes(name)) {
      return errorResult(
        `activate_skill: '${name}' is not available (available: ${ctx.available.join(", ") || "none"})`,
      );
    }
    try {
      const { instructions, resources } = ctx.loadInstructions(name);
      if (!instructions) {
        return errorResult(
          `activate_skill: skill '${name}' has no instructions`,
        );
      }
      let output = `<skill_content name="${name}">\n${instructions}\n</skill_content>`;
      if (resources.length > 0) {
        const list = resources.map((r) => `  <file>${r}</file>`).join("\n");
        output += `\n<skill_resources>\n${list}\n</skill_resources>`;
      }
      return { ok: true, output };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return errorResult(`activate_skill: ${msg}`);
    }
  };
  return {
    name: ACTIVATE_SKILL_TOOL_NAME,
    description: resolvePrompt("tools.activate_skill.description"),
    parameters: ACTIVATE_SKILL_SCHEMA,
    handler,
  };
}

function errorResult(msg: string): ToolResult {
  return { ok: false, output: msg, error: msg };
}
