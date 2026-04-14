/**
 * Core agent loop.
 *
 * Implements Mihail Eric's outer/inner loop pattern:
 *
 *   outer: accept user prompt → append to history
 *   inner: query LLM
 *     if tool_calls → execute each → append results → continue inner
 *     else          → done, return final response
 *
 * The queue is used to log every LLM request/response and tool call/result.
 * Memory is indexed after each complete turn and recalled before the next.
 */

import type { LlmConfig, EmbedConfig, MemoryConfig } from "../config.ts";
import type { ChatMessage } from "../llm/types.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { Database } from "bun:sqlite";
import type { BunnyQueue } from "../queue/bunqueue.ts";
import type { Renderer } from "./render.ts";

import { chat } from "../llm/adapter.ts";
import { buildSystemMessage } from "./prompt.ts";
import { insertMessage } from "../memory/messages.ts";
import { upsertEmbedding } from "../memory/vector.ts";
import { embed } from "../memory/embed.ts";
import { hybridRecall } from "../memory/recall.ts";

const MAX_TOOL_ITERATIONS = 20;

export interface RunAgentOptions {
  prompt: string;
  sessionId: string;
  llmCfg: LlmConfig;
  embedCfg: EmbedConfig;
  memoryCfg: MemoryConfig;
  tools: ToolRegistry;
  db: Database;
  queue: BunnyQueue;
  renderer: Renderer;
}

/** Run one user turn through the agent loop. Returns the final assistant response. */
export async function runAgent(opts: RunAgentOptions): Promise<string> {
  const { prompt, sessionId, llmCfg, embedCfg, memoryCfg, tools, db, queue, renderer } = opts;

  // ── Recall: inject relevant past messages into system prompt ──────────────
  const recall = await hybridRecall(db, embedCfg, prompt, memoryCfg.recallK, sessionId).catch(() => []);
  const systemMsg = buildSystemMessage(recall);

  // ── Store the user message ────────────────────────────────────────────────
  const userId = insertMessage(db, { sessionId, role: "user", content: prompt });
  void indexMessage(db, embedCfg, userId, prompt);
  void queue.log({ topic: "memory", kind: "index", sessionId, data: { role: "user" } });

  // Build the conversation history for this turn.
  const messages: ChatMessage[] = [systemMsg, { role: "user", content: prompt }];

  // ── Inner loop ────────────────────────────────────────────────────────────
  let iterations = 0;

  while (iterations++ < MAX_TOOL_ITERATIONS) {
    void queue.log({ topic: "llm", kind: "request", sessionId, data: { model: llmCfg.model } });
    const t0 = Date.now();

    const toolSchemas = tools.list();
    const { deltas, response } = await chat(llmCfg, {
      messages,
      tools: toolSchemas.length > 0 ? toolSchemas : undefined,
    });

    // Stream deltas to renderer.
    for await (const delta of deltas) {
      renderer.onDelta(delta);
    }

    const llmRes = await response;
    const durationMs = Date.now() - t0;

    void queue.log({
      topic: "llm",
      kind: "response",
      sessionId,
      data: { toolCalls: llmRes.message.tool_calls?.length ?? 0 },
      durationMs,
    });

    // Store assistant message (content + optional reasoning as separate rows).
    const assistantContent = llmRes.message.content ?? "";
    if (assistantContent) {
      const aid = insertMessage(db, { sessionId, role: "assistant", channel: "content", content: assistantContent });
      void indexMessage(db, embedCfg, aid, assistantContent);
    }
    if (llmRes.message.reasoning) {
      insertMessage(db, { sessionId, role: "assistant", channel: "reasoning", content: llmRes.message.reasoning });
    }

    messages.push(llmRes.message);

    // No tool calls → done.
    if (!llmRes.message.tool_calls || llmRes.message.tool_calls.length === 0) {
      renderer.onTurnEnd();
      return assistantContent;
    }

    // Execute tool calls in parallel.
    const toolResults = await Promise.all(
      llmRes.message.tool_calls.map(async (tc) => {
        void queue.log({ topic: "tool", kind: "call", sessionId, data: { name: tc.function.name } });
        const t1 = Date.now();
        const result = await tools.call(tc.function.name, tc.function.arguments);
        void queue.log({
          topic: "tool",
          kind: "result",
          sessionId,
          data: { name: tc.function.name, ok: result.ok },
          durationMs: Date.now() - t1,
          error: result.ok ? undefined : result.error,
        });
        return { tc, result };
      }),
    );

    for (const { tc, result } of toolResults) {
      renderer.onToolResult(tc.function.name, result);
      messages.push({ role: "tool", content: result.output, tool_call_id: tc.id });
      insertMessage(db, {
        sessionId,
        role: "tool",
        channel: "tool_result",
        content: result.output,
        toolCallId: tc.id,
        toolName: tc.function.name,
      });
    }
  }

  renderer.onError("Max tool iterations reached — stopping agent loop.");
  return "(agent stopped: too many tool calls)";
}

/** Embed and store a message's vector asynchronously (non-blocking). */
async function indexMessage(
  db: Database,
  embedCfg: EmbedConfig,
  messageId: number,
  text: string,
): Promise<void> {
  try {
    const vec = await embed(embedCfg, text);
    upsertEmbedding(db, messageId, vec);
  } catch {
    // Embedding failures are non-fatal (e.g. no API key in dev).
  }
}
