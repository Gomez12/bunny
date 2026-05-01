/**
 * Integration test: full agent loop against a mock LLM server.
 *
 * Scenario:
 *  1. User asks "read the config file"
 *  2. Mock LLM responds with a tool_call to read_file
 *  3. Agent executes read_file → gets content
 *  4. Mock LLM responds with a final text answer (no more tool calls)
 *  5. Assertions: final content returned, events logged, messages persisted
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Server = any;
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/memory/db.ts";
import { createBunnyQueue } from "../../src/queue/bunqueue.ts";
import { createRenderer } from "../../src/agent/render.ts";
import { runAgent } from "../../src/agent/loop.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { readFileHandler, READ_FILE_SCHEMA } from "../../src/tools/fs_read.ts";
import { queryEvents } from "../../src/queue/events.ts";
import { getMessagesBySession } from "../../src/memory/messages.ts";
import type { LlmConfig, EmbedConfig, MemoryConfig } from "../../src/config.ts";

// ---------------------------------------------------------------------------
// Mock LLM server

let server: Server;
let baseUrl: string;
let callCount = 0;
let originalCwd: string;
let tmp: string;

// The mock server returns two responses:
//  call 1 → tool_call: read_file({ path: "bunny.config.toml" })
//  call 2 → final text answer
function buildSse(chunks: unknown[]): string {
  return (
    chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") +
    "data: [DONE]\n\n"
  );
}

function toolCallResponse(): string {
  return buildSse([
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_abc",
                type: "function",
                function: { name: "read_file", arguments: "" },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                function: { arguments: '{"path":"bunny.config.toml"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    },
  ]);
}

function finalResponse(): string {
  return buildSse([
    {
      choices: [
        {
          index: 0,
          delta: { content: "Here is the config: " },
          finish_reason: null,
        },
      ],
    },
    {
      choices: [
        { index: 0, delta: { content: "[llm]" }, finish_reason: "stop" },
      ],
    },
  ]);
}

beforeAll(() => {
  originalCwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), "bunny-loop-"));
  process.chdir(tmp);

  // Create a minimal config file for the tool to read.
  writeFileSync(
    join(tmp, "bunny.config.toml"),
    '[llm]\nmodel = "test-model"\n',
  );

  callCount = 0;
  server = Bun.serve({
    port: 0,
    fetch() {
      callCount++;
      const body = callCount === 1 ? toolCallResponse() : finalResponse();
      return new Response(body, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        },
      });
    },
  });
  baseUrl = `http://localhost:${server.port}/v1`;
});

afterAll(() => {
  server.stop(true);
  process.chdir(originalCwd);
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

function makeLlmCfg(): LlmConfig {
  return {
    baseUrl,
    apiKey: "",
    model: "test",
    modelReasoning: undefined,
    profile: "openai",
    maxConcurrentRequests: 1,
  };
}

function makeEmbedCfg(): EmbedConfig {
  return { baseUrl, apiKey: "", model: "text-embedding-3-small", dim: 4 };
}

function makeMemCfg(): MemoryConfig {
  return { indexReasoning: false, recallK: 4, lastN: 10 };
}

describe("agent loop — full turn", () => {
  test("calls LLM twice: first with tool_call, then final answer", async () => {
    const db = await openDb(join(tmp, "agent.sqlite"), 4);
    const queue = createBunnyQueue(db);

    const output: string[] = [];
    const renderer = createRenderer({
      reasoningMode: "hidden",
      forceColor: false,
      out: { write: (s) => output.push(s) },
    });

    const tools = new ToolRegistry();
    tools.register(
      "read_file",
      "Read a file",
      READ_FILE_SCHEMA,
      readFileHandler,
    );

    const sessionId = "test-session-1";
    const result = await runAgent({
      prompt: "read the config file",
      sessionId,
      llmCfg: makeLlmCfg(),
      embedCfg: makeEmbedCfg(),
      memoryCfg: makeMemCfg(),
      tools,
      db,
      queue,
      renderer,
    });

    // The final assistant reply should include content from the second LLM call.
    expect(result).toContain("Here is the config");
    // The mock was called exactly twice.
    expect(callCount).toBe(2);

    // Wait for async queue processing.
    await queue.close();

    // Events table should have llm.request, llm.response, tool.call, tool.result rows.
    const events = queryEvents(db, { sessionId });
    const topics = events.map((e) => e.topic + "." + e.kind);
    expect(topics).toContain("llm.request");
    expect(topics).toContain("llm.response");
    expect(topics).toContain("tool.call");
    expect(topics).toContain("tool.result");

    // Messages table should have user + assistant + tool rows.
    const messages = getMessagesBySession(db, sessionId);
    const roles = messages.map((m) => m.role);
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");
    expect(roles).toContain("tool");

    db.close();
  });
});
