/**
 * Secret guard stores blocked messages with channel="error", not "content".
 * Regression: before this fix, the blocked assistant message was stored with
 * channel="content" and lost its error styling when loaded from the DB.
 */

import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/memory/db.ts";
import { createBunnyQueue } from "../../src/queue/bunqueue.ts";
import { runAgent } from "../../src/agent/loop.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { createSecret } from "../../src/memory/code_project_secrets.ts";
import { getMessagesBySession } from "../../src/memory/messages.ts";
import type { Renderer } from "../../src/agent/render.ts";
import type { LlmConfig, EmbedConfig, MemoryConfig } from "../../src/config.ts";

let tmp: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "bunny-secret-guard-"));
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeLlmCfg(): LlmConfig {
  return {
    baseUrl: "http://localhost:1",
    apiKey: "",
    model: "test",
    modelReasoning: undefined,
    profile: "openai",
    maxConcurrentRequests: 1,
  };
}

function makeEmbedCfg(): EmbedConfig {
  return {
    baseUrl: "http://localhost:1",
    apiKey: "",
    model: "text-embedding-3-small",
    dim: 4,
  };
}

function makeMemCfg(): MemoryConfig {
  return { indexReasoning: false, recallK: 4, lastN: 10 };
}

function makeCapturingRenderer(): { renderer: Renderer; errors: string[] } {
  const errors: string[] = [];
  const renderer: Renderer = {
    onDelta: () => {},
    onToolResult: () => {},
    onStats: () => {},
    onError: (m) => errors.push(m),
    onTurnEnd: () => {},
  };
  return { renderer, errors };
}

describe("agent loop — secret guard", () => {
  test("stores blocked message with channel='error', not 'content'", async () => {
    const db = await openDb(join(tmp, "guard.sqlite"), 4);
    const queue = createBunnyQueue(db);
    const { renderer, errors } = makeCapturingRenderer();

    // Insert a dummy code_project row so createSecret has a valid FK.
    // openDb already seeds the 'general' project row.
    db.run(`
      INSERT INTO code_projects (project, name, git_status, created_at, updated_at)
      VALUES ('general', 'myrepo', 'ready', 0, 0)
    `);
    const cpRow = db
      .query<{ id: number }, []>("SELECT id FROM code_projects LIMIT 1")
      .get();
    const cpId = cpRow!.id;

    // Create a secret with llm_forbidden=true.
    const secretValue = "supersecret_abc123";
    createSecret(db, {
      codeProjectId: cpId!,
      name: "API_KEY",
      value: secretValue,
      llmForbidden: true,
    });

    const sessionId = "guard-session-1";
    const result = await runAgent({
      prompt: `my key is ${secretValue}`,
      sessionId,
      llmCfg: makeLlmCfg(),
      embedCfg: makeEmbedCfg(),
      memoryCfg: makeMemCfg(),
      tools: new ToolRegistry(),
      db,
      queue,
      renderer,
    });

    // Should be blocked.
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("forbidden for LLM use");
    expect(result).toContain("forbidden for LLM use");

    // The assistant message in the DB must use channel="error", not "content".
    const messages = getMessagesBySession(db, sessionId);
    const assistantMsg = messages.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.channel).toBe("error");

    await queue.close();
    db.close();
  });
});
