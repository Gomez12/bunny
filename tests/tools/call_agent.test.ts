import { describe, expect, test } from "bun:test";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { makeCallAgentTool, MAX_AGENT_CALL_DEPTH } from "../../src/tools/call_agent.ts";

describe("ToolRegistry.subset + call_agent", () => {
  function baseRegistry() {
    const r = new ToolRegistry();
    r.register(
      "echo",
      "echo",
      { type: "object", properties: { m: { type: "string" } }, required: ["m"] },
      (args) => ({ ok: true, output: String(args["m"]) }),
    );
    r.register(
      "other",
      "other",
      { type: "object", properties: {}, required: [] },
      () => ({ ok: true, output: "other" }),
    );
    return r;
  }

  test("subset() filters by name", () => {
    const r = baseRegistry();
    const s = r.subset(["echo"]);
    expect(s.list().map((t) => t.function.name)).toEqual(["echo"]);
  });

  test("subset() with undefined copies everything", () => {
    const r = baseRegistry();
    const s = r.subset(undefined);
    expect(s.list().map((t) => t.function.name).sort()).toEqual(["echo", "other"]);
  });

  test("subset() adds extra tools", async () => {
    const r = baseRegistry();
    const extra = makeCallAgentTool({
      allowed: ["bob"],
      depth: 0,
      invoke: async () => "bob-reply",
    });
    const s = r.subset([], [extra]);
    expect(s.has("call_agent")).toBe(true);
    const result = await s.call("call_agent", JSON.stringify({ name: "bob", prompt: "hi" }));
    expect(result.ok).toBe(true);
    expect(result.output).toBe("bob-reply");
  });
});

describe("call_agent handler", () => {
  test("rejects names outside the whitelist", async () => {
    const tool = makeCallAgentTool({
      allowed: ["bob"],
      depth: 0,
      invoke: async () => "nope",
    });
    const result = await tool.handler({ name: "eve", prompt: "hi" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not in your allowed subagents/);
  });

  test("rejects missing prompt", async () => {
    const tool = makeCallAgentTool({ allowed: ["bob"], depth: 0, invoke: async () => "" });
    const result = await tool.handler({ name: "bob", prompt: "" });
    expect(result.ok).toBe(false);
  });

  test("enforces max depth", async () => {
    const tool = makeCallAgentTool({
      allowed: ["bob"],
      depth: MAX_AGENT_CALL_DEPTH,
      invoke: async () => "should not be called",
    });
    const result = await tool.handler({ name: "bob", prompt: "hi" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/max depth/);
  });

  test("surfaces invocation errors as ok=false", async () => {
    const tool = makeCallAgentTool({
      allowed: ["bob"],
      depth: 0,
      invoke: async () => {
        throw new Error("broken");
      },
    });
    const result = await tool.handler({ name: "bob", prompt: "hi" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/broken/);
  });
});
