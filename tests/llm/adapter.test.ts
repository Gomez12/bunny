import { afterAll, beforeAll, describe, expect, test } from "bun:test";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Server = any;
import type { LlmConfig } from "../../src/config.ts";
import { chat, chatSync, LlmError } from "../../src/llm/adapter.ts";

// ---------------------------------------------------------------------------
// Helpers

/** Encode a sequence of SSE data lines, then [DONE]. */
function buildSseBody(chunks: unknown[]): string {
  return (
    chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") +
    "data: [DONE]\n\n"
  );
}

function makeChunk(opts: {
  index?: number;
  content?: string;
  reasoning?: string;
  toolCallIndex?: number;
  toolCallId?: string;
  toolCallName?: string;
  toolCallArgs?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}) {
  const delta: Record<string, unknown> = {};
  if (opts.content) delta["content"] = opts.content;
  if (opts.reasoning) delta["reasoning_content"] = opts.reasoning;
  if (opts.toolCallIndex !== undefined) {
    delta["tool_calls"] = [
      {
        index: opts.toolCallIndex,
        ...(opts.toolCallId ? { id: opts.toolCallId } : {}),
        ...(opts.toolCallName
          ? {
              type: "function",
              function: {
                name: opts.toolCallName,
                arguments: opts.toolCallArgs ?? "",
              },
            }
          : { function: { arguments: opts.toolCallArgs ?? "" } }),
      },
    ];
  }

  return {
    choices: [{ index: opts.index ?? 0, delta, finish_reason: null }],
    ...(opts.usage ? { usage: opts.usage } : {}),
  };
}

// ---------------------------------------------------------------------------
// Mock server

let server: Server;
let baseUrl: string;

type MockHandler = (req: Request) => Response;
let currentHandler: MockHandler = () =>
  new Response("not configured", { status: 500 });

beforeAll(() => {
  server = Bun.serve({
    port: 0, // random free port
    fetch(req) {
      return currentHandler(req);
    },
  });
  baseUrl = `http://localhost:${server.port}/v1`;
});

afterAll(() => {
  server.stop(true);
});

function cfg(extra?: Partial<LlmConfig>): LlmConfig {
  return {
    baseUrl,
    apiKey: "",
    model: "test-model",
    modelReasoning: undefined,
    profile: "openai",
    maxConcurrentRequests: 1,
    ...extra,
  };
}

function sseHandler(chunks: unknown[]): MockHandler {
  const body = buildSseBody(chunks);
  return () =>
    new Response(body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      },
    });
}

// ---------------------------------------------------------------------------
// Tests

describe("chatSync — content only", () => {
  test("accumulates content chunks into message.content", async () => {
    currentHandler = sseHandler([
      makeChunk({ content: "Hello " }),
      makeChunk({ content: "world!" }),
    ]);
    const res = await chatSync(cfg(), {
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.message.content).toBe("Hello world!");
    expect(res.message.role).toBe("assistant");
    expect(res.message.tool_calls).toBeUndefined();
  });
});

describe("chatSync — reasoning", () => {
  test("normalises reasoning_content to message.reasoning", async () => {
    currentHandler = sseHandler([
      makeChunk({ reasoning: "Let me think..." }),
      makeChunk({ reasoning: " Done." }),
      makeChunk({ content: "42" }),
    ]);
    const res = await chatSync(cfg(), {
      messages: [{ role: "user", content: "what is 6*7?" }],
    });
    expect(res.message.reasoning).toBe("Let me think... Done.");
    expect(res.message.content).toBe("42");
  });

  test("deepseek profile also extracts reasoning_content", async () => {
    currentHandler = sseHandler([
      makeChunk({ reasoning: "Reasoning here" }),
      makeChunk({ content: "Answer" }),
    ]);
    const res = await chatSync(cfg({ profile: "deepseek" }), {
      messages: [{ role: "user", content: "?" }],
    });
    expect(res.message.reasoning).toBe("Reasoning here");
    expect(res.message.content).toBe("Answer");
  });

  test("ollama profile does not extract reasoning_content", async () => {
    currentHandler = sseHandler([
      makeChunk({ reasoning: "internal" }),
      makeChunk({ content: "Reply" }),
    ]);
    const res = await chatSync(cfg({ profile: "ollama" }), {
      messages: [{ role: "user", content: "?" }],
    });
    expect(res.message.reasoning).toBeUndefined();
    expect(res.message.content).toBe("Reply");
  });

  test("anthropic-compat profile extracts thinking field", async () => {
    // For anthropic-compat the delta field is `thinking`, not `reasoning_content`
    const anthropicChunk = {
      choices: [
        { index: 0, delta: { thinking: "deep thought" }, finish_reason: null },
      ],
    };
    const contentChunk = makeChunk({ content: "Result" });
    currentHandler = sseHandler([anthropicChunk, contentChunk]);
    const res = await chatSync(cfg({ profile: "anthropic-compat" }), {
      messages: [{ role: "user", content: "?" }],
    });
    expect(res.message.reasoning).toBe("deep thought");
  });
});

describe("chatSync — tool calls", () => {
  test("accumulates tool_call deltas into tool_calls array", async () => {
    currentHandler = sseHandler([
      makeChunk({
        toolCallIndex: 0,
        toolCallId: "call_1",
        toolCallName: "read_file",
        toolCallArgs: '{"path":',
      }),
      makeChunk({ toolCallIndex: 0, toolCallArgs: '"src/index.ts"}' }),
    ]);
    const res = await chatSync(cfg(), {
      messages: [{ role: "user", content: "read index" }],
    });
    expect(res.message.tool_calls).toHaveLength(1);
    const tc = res.message.tool_calls![0]!;
    expect(tc.function.name).toBe("read_file");
    expect(JSON.parse(tc.function.arguments)).toEqual({ path: "src/index.ts" });
  });
});

describe("chatSync — usage", () => {
  test("captures token usage when provided", async () => {
    currentHandler = sseHandler([
      makeChunk({
        content: "hi",
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    ]);
    const res = await chatSync(cfg(), {
      messages: [{ role: "user", content: "hello" }],
    });
    expect(res.usage?.totalTokens).toBe(15);
  });
});

describe("chat — streaming deltas", () => {
  test("deltas arrive in order: reasoning then content", async () => {
    currentHandler = sseHandler([
      makeChunk({ reasoning: "think" }),
      makeChunk({ content: "answer" }),
    ]);
    const { deltas } = await chat(cfg(), {
      messages: [{ role: "user", content: "?" }],
    });
    const collected: string[] = [];
    for await (const d of deltas) {
      collected.push(d.channel);
    }
    expect(collected).toEqual(["reasoning", "content"]);
  });
});

describe("error handling", () => {
  test("throws LlmError on non-200 response", async () => {
    currentHandler = () => new Response("Unauthorized", { status: 401 });
    await expect(
      chatSync(cfg(), { messages: [{ role: "user", content: "?" }] }),
    ).rejects.toBeInstanceOf(LlmError);
  });
});

describe("profile detection", () => {
  test("detect openai from api.openai.com URL", async () => {
    // We only test profile auto-detection from URL; no actual request needed.
    const { getProfile, detectProfile } =
      await import("../../src/llm/profiles.ts");
    expect(detectProfile("https://api.openai.com/v1")).toBe("openai");
    expect(detectProfile("https://openrouter.ai/api/v1")).toBe("openrouter");
    expect(detectProfile("https://api.deepseek.com/v1")).toBe("deepseek");
    expect(detectProfile("http://localhost:11434/v1")).toBe("ollama");
    expect(getProfile(undefined, "https://api.openai.com/v1").id).toBe(
      "openai",
    );
  });
});
