/**
 * Verifies that the agent loop replays the last N user/assistant turns
 * verbatim on subsequent requests within the same session (MemoryConfig.lastN).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Server = any;
import { openDb } from "../../src/memory/db.ts";
import { createBunnyQueue } from "../../src/queue/bunqueue.ts";
import { createRenderer } from "../../src/agent/render.ts";
import { runAgent } from "../../src/agent/loop.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import type { LlmConfig, EmbedConfig, MemoryConfig } from "../../src/config.ts";

interface CapturedBody {
  messages: Array<{ role: string; content: string | null }>;
}

let server: Server;
let baseUrl: string;
let tmp: string;
const captured: CapturedBody[] = [];

function sseFinal(text: string): string {
  return (
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }] })}\n\n` +
    "data: [DONE]\n\n"
  );
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "bunny-history-"));
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as CapturedBody;
      captured.push(body);
      const n = captured.length;
      return new Response(sseFinal(`reply-${n}`), {
        headers: { "Content-Type": "text/event-stream" },
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
  return { baseUrl, apiKey: "", model: "test", modelReasoning: undefined, profile: "openai" };
}
function makeEmbedCfg(): EmbedConfig {
  return { baseUrl, apiKey: "", model: "x", dim: 4 };
}

describe("agent loop — verbatim history replay", () => {
  test("second turn payload contains the first turn's user+assistant messages", async () => {
    const db = await openDb(join(tmp, "history.sqlite"), 4);
    const queue = createBunnyQueue(db);
    const renderer = createRenderer({ reasoningMode: "hidden", forceColor: false, out: { write: () => {} } });
    const tools = new ToolRegistry();
    const memCfg: MemoryConfig = { indexReasoning: false, recallK: 4, lastN: 10 };

    const sessionId = "hist-1";
    captured.length = 0;

    await runAgent({
      prompt: "waar ligt amsterdam",
      sessionId,
      llmCfg: makeLlmCfg(),
      embedCfg: makeEmbedCfg(),
      memoryCfg: memCfg,
      tools,
      db,
      queue,
      renderer,
    });

    await runAgent({
      prompt: "weet je dat zeker, ligt het niet in belgie",
      sessionId,
      llmCfg: makeLlmCfg(),
      embedCfg: makeEmbedCfg(),
      memoryCfg: memCfg,
      tools,
      db,
      queue,
      renderer,
    });

    expect(captured).toHaveLength(2);

    // First call: just system + new user prompt — no prior history exists.
    const firstRoles = captured[0]!.messages.map((m) => m.role);
    expect(firstRoles).toEqual(["system", "user"]);

    // Second call: system + (user + assistant from turn 1) + new user.
    const secondMsgs = captured[1]!.messages;
    expect(secondMsgs.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(secondMsgs[1]!.content).toBe("waar ligt amsterdam");
    expect(secondMsgs[2]!.content).toBe("reply-1");
    expect(secondMsgs[3]!.content).toBe("weet je dat zeker, ligt het niet in belgie");

    await queue.close();
    db.close();
  });

  test("lastN = 0 disables verbatim replay (recall-only)", async () => {
    const db = await openDb(join(tmp, "history2.sqlite"), 4);
    const queue = createBunnyQueue(db);
    const renderer = createRenderer({ reasoningMode: "hidden", forceColor: false, out: { write: () => {} } });
    const tools = new ToolRegistry();
    const memCfg: MemoryConfig = { indexReasoning: false, recallK: 4, lastN: 0 };

    const sessionId = "hist-2";
    captured.length = 0;

    await runAgent({
      prompt: "first",
      sessionId,
      llmCfg: makeLlmCfg(),
      embedCfg: makeEmbedCfg(),
      memoryCfg: memCfg,
      tools,
      db,
      queue,
      renderer,
    });
    await runAgent({
      prompt: "second",
      sessionId,
      llmCfg: makeLlmCfg(),
      embedCfg: makeEmbedCfg(),
      memoryCfg: memCfg,
      tools,
      db,
      queue,
      renderer,
    });

    const roles = captured[1]!.messages.map((m) => m.role);
    expect(roles).toEqual(["system", "user"]);

    await queue.close();
    db.close();
  });
});
