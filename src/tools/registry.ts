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

export interface ToolDescriptor {
  name: string;
  description: string;
  parameters: JsonSchemaObject;
  handler: ToolHandler;
}

export interface RegisteredTool {
  schema: ToolSchema;
  handler: ToolHandler;
}

export function toolOk(value: unknown): ToolResult {
  return { ok: true, output: typeof value === "string" ? value : JSON.stringify(value) };
}

export function toolErr(msg: string): ToolResult {
  return { ok: false, output: msg, error: msg };
}

export function getString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
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

  /**
   * Tool schemas, ready to be sent in a chat request. When `filter` is an
   * array, only schemas whose names appear in it are returned (preserving the
   * caller-supplied order). When `filter` is `undefined`, every registered
   * tool is returned.
   */
  list(filter?: readonly string[]): ToolSchema[] {
    if (!filter) return [...this.tools.values()].map((t) => t.schema);
    const out: ToolSchema[] = [];
    for (const name of filter) {
      const t = this.tools.get(name);
      if (t) out.push(t.schema);
    }
    return out;
  }

  /** All registered names, useful for UI pickers. */
  names(): string[] {
    return [...this.tools.keys()];
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

  /**
   * Return a new registry containing the named subset of tools from this
   * registry, plus any extra tools supplied inline (useful to inject a
   * closure-bound `call_agent` for a specific run without mutating the
   * shared singleton). A `filter` of `undefined` copies all tools.
   */
  subset(
    filter: readonly string[] | undefined,
    extras: ToolDescriptor[] = [],
  ): ToolRegistry {
    const next = new ToolRegistry();
    const source = filter ? filter.filter((n) => this.tools.has(n)) : [...this.tools.keys()];
    for (const name of source) {
      const tool = this.tools.get(name)!;
      next.tools.set(name, tool);
    }
    for (const e of extras) {
      next.register(e.name, e.description, e.parameters, e.handler);
    }
    return next;
  }
}

/** Singleton registry used by the agent loop. Import and register your tools here. */
export const registry = new ToolRegistry();
