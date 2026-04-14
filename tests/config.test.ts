import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";

function newCwd(): string {
  return mkdtempSync(join(tmpdir(), "bunny-cfg-"));
}

describe("loadConfig", () => {
  test("returns defaults when nothing set", () => {
    const cfg = loadConfig({ env: {}, cwd: newCwd() });
    expect(cfg.llm.baseUrl).toBe("https://api.openai.com/v1");
    expect(cfg.llm.model).toBe("gpt-4o-mini");
    expect(cfg.embed.dim).toBe(1536);
    expect(cfg.memory.indexReasoning).toBe(false);
    expect(cfg.render.reasoning).toBe("collapsed");
    expect(cfg.queue.topics).toEqual(["llm", "tool", "memory"]);
  });

  test("env overrides defaults", () => {
    const cfg = loadConfig({
      env: { LLM_BASE_URL: "http://localhost:11434/v1", LLM_MODEL: "llama3", LLM_API_KEY: "sk-x" },
      cwd: newCwd(),
    });
    expect(cfg.llm.baseUrl).toBe("http://localhost:11434/v1");
    expect(cfg.llm.model).toBe("llama3");
    expect(cfg.llm.apiKey).toBe("sk-x");
  });

  test("TOML overrides defaults but loses to env", () => {
    const cwd = newCwd();
    writeFileSync(
      join(cwd, "bunny.config.toml"),
      [
        "[llm]",
        'base_url = "https://toml.example/v1"',
        'model = "from-toml"',
        'profile = "deepseek"',
        "[memory]",
        "index_reasoning = true",
        "recall_k = 12",
        "[render]",
        'reasoning = "inline"',
      ].join("\n"),
    );
    const cfg = loadConfig({ env: { LLM_MODEL: "from-env" }, cwd });
    expect(cfg.llm.baseUrl).toBe("https://toml.example/v1"); // TOML wins over default
    expect(cfg.llm.model).toBe("from-env");                  // env wins over TOML
    expect(cfg.llm.profile).toBe("deepseek");
    expect(cfg.memory.indexReasoning).toBe(true);
    expect(cfg.memory.recallK).toBe(12);
    expect(cfg.render.reasoning).toBe("inline");
  });

  test("rejects unknown profile silently (falls back to undefined)", () => {
    const cfg = loadConfig({ env: { LLM_PROFILE: "bogus" }, cwd: newCwd() });
    expect(cfg.llm.profile).toBeUndefined();
  });

  test("EMBED_API_KEY falls back to LLM_API_KEY", () => {
    const cfg = loadConfig({ env: { LLM_API_KEY: "sk-shared" }, cwd: newCwd() });
    expect(cfg.embed.apiKey).toBe("sk-shared");
  });
});
