import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureAgentDir,
  loadAgentAssets,
  writeAgentAssets,
} from "../../src/memory/agent_assets.ts";

let tmp: string;
const ORIGINAL_HOME = process.env["BUNNY_HOME"];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "bunny-agentassets-"));
  process.env["BUNNY_HOME"] = tmp;
});
afterEach(() => {
  if (ORIGINAL_HOME === undefined) delete process.env["BUNNY_HOME"];
  else process.env["BUNNY_HOME"] = ORIGINAL_HOME;
  rmSync(tmp, { recursive: true, force: true });
});

describe("agent_assets", () => {
  test("ensureAgentDir writes stub config.toml", () => {
    const dir = ensureAgentDir("bob");
    const toml = readFileSync(join(dir, "config.toml"), "utf8");
    expect(toml).toContain("append = false");
    expect(toml).toContain("allowed_subagents = []");
  });

  test("loadAgentAssets returns defaults for missing files", () => {
    const assets = loadAgentAssets("noone");
    expect(assets.systemPrompt.prompt).toBe("");
    expect(assets.systemPrompt.append).toBe(false);
    expect(assets.memory.lastN).toBeNull();
    expect(assets.memory.recallK).toBeNull();
    expect(assets.tools).toBeUndefined();
    expect(assets.allowedSubagents).toEqual([]);
  });

  test("writeAgentAssets + loadAgentAssets roundtrips tools and subs", () => {
    ensureAgentDir("ada");
    writeAgentAssets("ada", {
      systemPrompt: { prompt: "I am Ada.", append: false },
      memory: { lastN: 4, recallK: 0 },
      tools: ["read_file", "list_dir"],
      allowedSubagents: ["bob"],
    });
    const assets = loadAgentAssets("ada");
    expect(assets.systemPrompt.prompt.trim()).toBe("I am Ada.");
    expect(assets.memory).toEqual({ lastN: 4, recallK: 0 });
    expect(assets.tools).toEqual(["read_file", "list_dir"]);
    expect(assets.allowedSubagents).toEqual(["bob"]);
  });

  test("tools = null clears the whitelist (inherit-all)", () => {
    ensureAgentDir("ada");
    writeAgentAssets("ada", { tools: ["read_file"] });
    expect(loadAgentAssets("ada").tools).toEqual(["read_file"]);
    writeAgentAssets("ada", { tools: null });
    expect(loadAgentAssets("ada").tools).toBeUndefined();
  });
});
