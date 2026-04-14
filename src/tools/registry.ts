/**
 * Tool registry.
 *
 * Tools are registered with a name, a JSON-schema description, and a handler
 * function. The registry exposes:
 *  - `list()` — schemas to include in the next LLM request
 *  - `call(name, args)` — execute a tool and return a serialisable result
 */

import type { JsonSchemaObject, ToolSchema } from "../llm/types.ts";

export interface ToolResult {
  /** Human-readable (and LLM-readable) output. */
  output: string;
  /** True when the tool executed without error. */
  ok: boolean;
  /** Original error message if ok = false. */
  error?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ToolHandler = (args: Record<string, any>) => Promise<ToolResult> | ToolResult;

export interface RegisteredTool {
  schema: ToolSchema;
  handler: ToolHandler;
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  /** Register a tool. Overwrites any previous registration with the same name. */
  register(name: string, description: string, parameters: JsonSchemaObject, handler: ToolHandler): void {
    this.tools.set(name, {
      schema: { type: "function", function: { name, description, parameters } },
      handler,
    });
  }

  /** All tool schemas, ready to be sent in a chat request. */
  list(): ToolSchema[] {
    return [...this.tools.values()].map((t) => t.schema);
  }

  /** Execute a named tool. Returns an error ToolResult if the name is unknown. */
  async call(name: string, rawArgs: string): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, output: `Unknown tool: ${name}`, error: `Unknown tool: ${name}` };
    }

    let args: Record<string, unknown>;
    try {
      args = JSON.parse(rawArgs) as Record<string, unknown>;
    } catch {
      return { ok: false, output: `Invalid JSON arguments for ${name}`, error: "JSON parse error" };
    }

    try {
      return await tool.handler(args);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, output: `Tool ${name} threw: ${msg}`, error: msg };
    }
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }
}

/** Singleton registry used by the agent loop. Import and register your tools here. */
export const registry = new ToolRegistry();
