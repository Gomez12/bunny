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

import type { LlmConfig, EmbedConfig, MemoryConfig, AgentConfig } from "../config.ts";
import type { ChatMessage } from "../llm/types.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { Database } from "bun:sqlite";
import type { BunnyQueue } from "../queue/bunqueue.ts";
import type { Renderer } from "./render.ts";

import { chat } from "../llm/adapter.ts";
import { buildSystemMessage } from "./prompt.ts";
import { insertMessage, getRecentTurns } from "../memory/messages.ts";
import { upsertEmbedding } from "../memory/vector.ts";
import { embed } from "../memory/embed.ts";
import { hybridRecall } from "../memory/recall.ts";
import { DEFAULT_PROJECT, getSessionProject } from "../memory/projects.ts";
import { loadProjectAssets } from "../memory/project_assets.ts";

const MAX_TOOL_ITERATIONS = 20;

export interface RunAgentOptions {
  prompt: string;
  sessionId: string;
  /** Owning user id — stamped onto every message/event produced this turn. */
  userId?: string;
  /** Owning project. Defaults to `agentCfg.defaultProject` / 'general' when omitted. */
  project?: string;
  llmCfg: LlmConfig;
  embedCfg: EmbedConfig;
  memoryCfg: MemoryConfig;
  /** Optional — carries the base system prompt + default project name from config. */
  agentCfg?: AgentConfig;
  tools: ToolRegistry;
  db: Database;
  queue: BunnyQueue;
  renderer: Renderer;
}

/** Run one user turn through the agent loop. Returns the final assistant response. */
export async function runAgent(opts: RunAgentOptions): Promise<string> {
  const { prompt, sessionId, userId, llmCfg, embedCfg, memoryCfg, agentCfg, tools, db, queue, renderer } = opts;
  const project = opts.project ?? agentCfg?.defaultProject ?? DEFAULT_PROJECT;

  // Enforce the "one project per session" invariant: once a session has any
  // messages, every subsequent turn must target the same project.
  const existingProject = getSessionProject(db, sessionId);
  const hasExisting = db
    .prepare(`SELECT 1 AS x FROM messages WHERE session_id = ? LIMIT 1`)
    .get(sessionId) as { x: number } | undefined;
  if (hasExisting && existingProject !== project) {
    throw new Error(
      `session '${sessionId}' belongs to project '${existingProject}', cannot run under '${project}'`,
    );
  }

  const projectAssets = loadProjectAssets(project);

  // ── Short-term history: verbatim replay of the last N turns ───────────────
  // Fetched BEFORE inserting the new user prompt so the current message isn't
  // duplicated. Keeps conversational coherence that recall alone misses when
  // the follow-up shares no tokens with the earlier turn.
  const recentTurns = getRecentTurns(db, sessionId, memoryCfg.lastN);
  const recentIds = new Set(recentTurns.map((t) => t.messageId));

  // ── Recall: BM25 + kNN over the rest of history, excluding verbatim rows ──
  const recall = await hybridRecall(
    db,
    embedCfg,
    prompt,
    memoryCfg.recallK,
    sessionId,
    project,
    recentIds,
  ).catch(() => []);
  const systemMsg = buildSystemMessage({ recall, projectAssets, baseSystem: agentCfg?.systemPrompt });

  // ── Store the user message ────────────────────────────────────────────────
  const userMsgId = insertMessage(db, { sessionId, userId, project, role: "user", content: prompt });
  void indexMessage(db, embedCfg, userMsgId, prompt);
  void queue.log({ topic: "memory", kind: "index", sessionId, data: { role: "user" } });

  // Build the conversation history for this turn.
  const messages: ChatMessage[] = [
    systemMsg,
    ...recentTurns.map(({ role, content }) => ({ role, content })),
    { role: "user", content: prompt },
  ];

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

    // Store assistant message (reasoning + content as separate rows).
    // Reasoning is inserted first so the Messages tab (ordered by ts ASC) shows
    // the thinking block above the answer — matching the reader's mental model.
    // Stats (duration + tokens) are attached so the UI can show per-call
    // throughput; only the content row carries them to avoid double-counting.
    const assistantContent = llmRes.message.content ?? "";
    const stats = {
      durationMs,
      promptTokens: llmRes.usage?.promptTokens,
      completionTokens: llmRes.usage?.completionTokens,
    };
    if (llmRes.message.reasoning) {
      insertMessage(db, { sessionId, userId, project, role: "assistant", channel: "reasoning", content: llmRes.message.reasoning });
    }
    if (assistantContent) {
      const aid = insertMessage(db, {
        sessionId,
        userId,
        project,
        role: "assistant",
        channel: "content",
        content: assistantContent,
        ...stats,
      });
      void indexMessage(db, embedCfg, aid, assistantContent);
    }
    renderer.onStats(stats);

    messages.push(llmRes.message);

    // No tool calls → done.
    if (!llmRes.message.tool_calls || llmRes.message.tool_calls.length === 0) {
      renderer.onTurnEnd();
      return assistantContent;
    }

    // Persist each tool_call (args) as its own row so the UI can reconstruct
    // the tool card on reload. Paired with the tool_result row via tool_call_id.
    for (const tc of llmRes.message.tool_calls) {
      insertMessage(db, {
        sessionId,
        userId,
        project,
        role: "assistant",
        channel: "tool_call",
        content: tc.function.arguments,
        toolCallId: tc.id,
        toolName: tc.function.name,
      });
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
        userId,
        project,
        role: "tool",
        channel: "tool_result",
        content: result.output,
        toolCallId: tc.id,
        toolName: tc.function.name,
        ok: result.ok,
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
