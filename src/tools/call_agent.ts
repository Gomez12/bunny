/**
 * `call_agent` tool — lets an orchestrator agent invoke one of its
 * `allowed_subagents` as a sub-`runAgent` call, returning the subagent's
 * final answer as a tool result. A depth-guard prevents runaway recursion.
 *
 * Because every call needs the live db / queue / session context of the
 * parent turn, we don't register this on the shared {@link registry}. Each
 * `runAgent` builds a closure-bound handler via {@link makeCallAgentTool}
 * and splices it into a per-run subset registry.
 */

import type { JsonSchemaObject } from "../llm/types.ts";
import type { ToolHandler, ToolResult } from "./registry.ts";

export const CALL_AGENT_TOOL_NAME = "call_agent";

export const CALL_AGENT_DESCRIPTION =
  "Delegate a task to one of your allowed subagents. The named agent runs with its own system prompt and tools and returns a single final answer.";

export const CALL_AGENT_SCHEMA: JsonSchemaObject = {
  type: "object",
  properties: {
    name: {
      type: "string",
      description: "Subagent name. Must be one of your allowed subagents.",
    },
    prompt: {
      type: "string",
      description: "The task / question to hand off. Include all context the subagent needs.",
    },
  },
  required: ["name", "prompt"],
};

export const MAX_AGENT_CALL_DEPTH = 2;

export interface CallAgentContext {
  /** Invoke a subagent run; implementation lives in the loop. */
  invoke(name: string, prompt: string): Promise<string>;
  /** Names the caller is allowed to invoke. */
  allowed: readonly string[];
  /** Current depth in the agent-call chain. 0 = user-facing agent. */
  depth: number;
}

export function makeCallAgentTool(ctx: CallAgentContext): {
  name: string;
  description: string;
  parameters: JsonSchemaObject;
  handler: ToolHandler;
} {
  const handler: ToolHandler = async (args) => {
    const name = typeof args["name"] === "string" ? args["name"].trim() : "";
    const prompt = typeof args["prompt"] === "string" ? args["prompt"] : "";
    if (!name) return errorResult("call_agent: 'name' is required");
    if (!prompt) return errorResult("call_agent: 'prompt' is required");
    if (!ctx.allowed.includes(name)) {
      return errorResult(
        `call_agent: '${name}' is not in your allowed subagents (${ctx.allowed.join(", ") || "none"})`,
      );
    }
    if (ctx.depth >= MAX_AGENT_CALL_DEPTH) {
      return errorResult(`call_agent: max depth ${MAX_AGENT_CALL_DEPTH} reached`);
    }
    try {
      const answer = await ctx.invoke(name, prompt);
      return { ok: true, output: answer || "(subagent returned no output)" };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return errorResult(`call_agent: ${msg}`);
    }
  };
  return {
    name: CALL_AGENT_TOOL_NAME,
    description: CALL_AGENT_DESCRIPTION,
    parameters: CALL_AGENT_SCHEMA,
    handler,
  };
}

function errorResult(msg: string): ToolResult {
  return { ok: false, output: msg, error: msg };
}
