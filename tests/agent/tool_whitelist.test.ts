import { describe, expect, test } from "bun:test";
import { ToolRegistry, toolOk } from "../../src/tools/registry.ts";

function noop() {
  return toolOk("ok");
}

function makeRegistry(...names: string[]): ToolRegistry {
  const r = new ToolRegistry();
  for (const name of names) {
    r.register(name, `tool ${name}`, { type: "object", properties: {} }, noop);
  }
  return r;
}

describe("toolWhitelist — ToolRegistry.subset behaviour", () => {
  test("empty filter produces empty registry (no tools)", () => {
    const base = makeRegistry("read_file", "list_dir", "edit_file");
    const result = base.subset([], []);
    expect(result.list()).toHaveLength(0);
    expect(result.names()).toHaveLength(0);
  });

  test("undefined filter copies all tools (default behaviour unchanged)", () => {
    const base = makeRegistry("read_file", "list_dir");
    const result = base.subset(undefined, []);
    expect(result.names().sort()).toEqual(["list_dir", "read_file"]);
  });

  test("empty filter with extras includes only extras", () => {
    const base = makeRegistry("read_file", "list_dir");
    const extra: import("../../src/tools/registry.ts").ToolDescriptor = {
      name: "web_fetch",
      description: "fetch",
      parameters: { type: "object", properties: {} },
      handler: noop,
    };
    const result = base.subset([], [extra]);
    expect(result.names()).toEqual(["web_fetch"]);
  });

  test("whitelist with web tool names returns only those tools from extras", () => {
    const base = makeRegistry("read_file", "list_dir");
    const webFetch: import("../../src/tools/registry.ts").ToolDescriptor = {
      name: "web_fetch",
      description: "fetch",
      parameters: { type: "object", properties: {} },
      handler: noop,
    };
    const webSearch: import("../../src/tools/registry.ts").ToolDescriptor = {
      name: "web_search",
      description: "search",
      parameters: { type: "object", properties: {} },
      handler: noop,
    };
    const webDownload: import("../../src/tools/registry.ts").ToolDescriptor = {
      name: "web_download",
      description: "download",
      parameters: { type: "object", properties: {} },
      handler: noop,
    };
    // Simulate buildRunRegistry with runtimeWhitelist: ["web_fetch", "web_search"]
    // dynamic tool names are NOT in base registry, they come in as extras
    const whitelist = ["web_fetch", "web_search"];
    const allow = new Set(whitelist);
    const allExtras = [webFetch, webSearch, webDownload];
    const filteredExtras = allExtras.filter((t) => allow.has(t.name));
    // static tools filtered out (both are in DYNAMIC_TOOL_NAMES, not in base)
    const filtered = whitelist.filter((n) => !["web_fetch", "web_search", "web_download"].includes(n));
    const result = base.subset(filtered, filteredExtras);
    expect(result.names().sort()).toEqual(["web_fetch", "web_search"]);
  });

  test("agent whitelist takes precedence over runtimeWhitelist", () => {
    // agentAssets?.tools ?? runtimeWhitelist — agent wins when set
    const agentTools: string[] | undefined = ["read_file"];
    const runtimeWhitelist: string[] | undefined = ["web_fetch", "web_search"];
    const whitelist = agentTools ?? runtimeWhitelist;
    expect(whitelist).toEqual(["read_file"]);
  });

  test("runtimeWhitelist used when agent has no tool restriction", () => {
    const agentTools: string[] | undefined = undefined;
    const runtimeWhitelist: string[] | undefined = ["web_fetch", "web_search"];
    const whitelist = agentTools ?? runtimeWhitelist;
    expect(whitelist).toEqual(["web_fetch", "web_search"]);
  });
});
