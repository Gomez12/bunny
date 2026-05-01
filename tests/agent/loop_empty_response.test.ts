/**
 * Empty-response handling in the agent loop.
 *
 * Some reasoning-mode models route their entire turn — including the
 * would-be answer or tool call — through the reasoning channel, leaving
 * us with empty content + no tool_calls. The loop must:
 *
 *   1. Pop the empty assistant turn from the in-memory history.
 *   2. Inject a synthetic user-message nudge and retry once.
 *   3. If still empty, surface an error via `renderer.onError` instead of
 *      silently returning "" — without this, the chat just hangs.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Server = any;
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/memory/db.ts";
import { createBunnyQueue } from "../../src/queue/bunqueue.ts";
import { runAgent } from "../../src/agent/loop.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import type { Renderer } from "../../src/agent/render.ts";
import type {
  LlmConfig,
  EmbedConfig,
  MemoryConfig,
} from "../../src/config.ts";

let server: Server;
let baseUrl: string;
let callCount = 0;
let tmp: string;

function buildSse(chunks: unknown[]): string {
  return (
    chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") +
    "data: [DONE]\n\n"
  );
}

/** A response with reasoning text only — empty content, no tool_calls. */
function reasoningOnlyResponse(): string {
  return buildSse([
    {
      choices: [
        {
          index: 0,
          delta: { reasoning_content: "Thinking about it… </think>" },
          finish_reason: null,
        },
      ],
    },
    {
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "stop",
        },
      ],
    },
  ]);
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "bunny-loop-empty-"));
  callCount = 0;
  server = Bun.serve({
    port: 0,
    fetch() {
      callCount++;
      // Every response is reasoning-only — the loop must nudge once and
      // then bail with an error rather than spin forever.
      return new Response(reasoningOnlyResponse(), {
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
  rmSync(tmp, { recursive: true, force: true });
});

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

function makeCapturingRenderer(): {
  renderer: Renderer;
  errors: string[];
  state: { turnEnded: boolean };
} {
  const errors: string[] = [];
  const state = { turnEnded: false };
  const renderer: Renderer = {
    onDelta: () => {},
    onToolResult: () => {},
    onStats: () => {},
    onError: (m) => {
      errors.push(m);
    },
    onTurnEnd: () => {
      state.turnEnded = true;
    },
  };
  return { renderer, errors, state };
}

describe("agent loop — empty-response handling", () => {
  test("nudges once then surfaces onError when reasoning-only persists", async () => {
    const db = await openDb(join(tmp, "empty.sqlite"), 4);
    const queue = createBunnyQueue(db);
    const captured = makeCapturingRenderer();

    const result = await runAgent({
      prompt: "explain something",
      sessionId: "empty-session-1",
      llmCfg: makeLlmCfg(),
      embedCfg: makeEmbedCfg(),
      memoryCfg: makeMemCfg(),
      tools: new ToolRegistry(),
      db,
      queue,
      renderer: captured.renderer,
    });

    expect(result).toBe("");
    expect(callCount).toBe(2);
    expect(captured.errors.length).toBe(1);
    expect(captured.errors[0]).toMatch(/no visible answer/i);
    expect(captured.state.turnEnded).toBe(true);

    await queue.close();
    db.close();
  });
});
