import { describe, expect, test } from "bun:test";
import { ToolRegistry } from "../../src/tools/registry.ts";

describe("ToolRegistry", () => {
  function makeRegistry() {
    const r = new ToolRegistry();
    r.register(
      "echo",
      "Echo the message back",
      { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
      (args) => ({ ok: true, output: String(args["message"]) }),
    );
    return r;
  }

  test("list() returns registered schemas", () => {
    const r = makeRegistry();
    const schemas = r.list();
    expect(schemas).toHaveLength(1);
    expect(schemas[0]?.function.name).toBe("echo");
  });

  test("call() invokes handler and returns output", async () => {
    const r = makeRegistry();
    const result = await r.call("echo", JSON.stringify({ message: "hello" }));
    expect(result.ok).toBe(true);
    expect(result.output).toBe("hello");
  });

  test("call() returns error result for unknown tool", async () => {
    const r = makeRegistry();
    const result = await r.call("nonexistent", "{}");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/unknown tool/i);
  });

  test("call() returns error on invalid JSON args", async () => {
    const r = makeRegistry();
    const result = await r.call("echo", "not-json");
    expect(result.ok).toBe(false);
  });

  test("call() catches handler throws", async () => {
    const r = new ToolRegistry();
    r.register("boom", "throws", { type: "object", properties: {}, required: [] }, () => {
      throw new Error("kaboom");
    });
    const result = await r.call("boom", "{}");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch("kaboom");
  });
});
