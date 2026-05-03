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
 * Every LLM request/response and tool call/result is logged via the queue.
 * Context on each turn comes from three sources: the (possibly project-scoped
 * or agent-scoped) system prompt, the last-N user/assistant turns replayed
 * verbatim, and hybrid BM25+kNN recall over the rest of history.
 *
 * When `agent` is set the loop switches to that agent's prompt, filtered
 * tools and memory knobs; outgoing messages and SSE events are tagged with
 * the agent's name (`author`). Sub-agent invocation is exposed as the
 * `call_agent` tool when the agent has `allowed_subagents`.
 */

import type {
  LlmConfig,
  EmbedConfig,
  MemoryConfig,
  AgentConfig,
  WebConfig,
  TelegramConfig,
} from "../config.ts";
import type { ChatAttachment, ChatMessage } from "../llm/types.ts";
import type { ToolRegistry, ToolDescriptor } from "../tools/registry.ts";
import type { Database } from "bun:sqlite";
import type { BunnyQueue } from "../queue/bunqueue.ts";
import type { Renderer } from "./render.ts";

import { chat } from "../llm/adapter.ts";
import { ensureGlobalGate } from "../llm/concurrency_gate.ts";
import { buildSystemMessage, type PeerAgentDescriptor } from "./prompt.ts";
import { silentRenderer } from "./render.ts";
import { insertMessage, getRecentTurns } from "../memory/messages.ts";
import { upsertEmbedding } from "../memory/vector.ts";
import { embed } from "../memory/embed.ts";
import { hybridRecall } from "../memory/recall.ts";
import { DEFAULT_PROJECT, getSessionProject } from "../memory/projects.ts";
import { truncate } from "../util/log.ts";
import { loadProjectAssets } from "../memory/project_assets.ts";
import { loadMemoryContext } from "../memory/refresh_helpers.ts";
import {
  getAgent,
  isAgentLinkedToProject,
  listAgentsForProject,
} from "../memory/agents.ts";
import { loadAgentAssets } from "../memory/agent_assets.ts";
import {
  makeCallAgentTool,
  CALL_AGENT_TOOL_NAME,
} from "../tools/call_agent.ts";
import {
  makeBoardTools,
  BOARD_TOOL_NAMES,
  type BoardToolContext,
} from "../tools/board.ts";
import {
  makeWorkspaceTools,
  WORKSPACE_TOOL_NAMES,
} from "../tools/workspace.ts";
import { makeWebTools, WEB_TOOL_NAMES } from "../tools/web.ts";
import {
  makeActivateSkillTool,
  ACTIVATE_SKILL_TOOL_NAME,
} from "../tools/activate_skill.ts";
import { makeAskUserTool, ASK_USER_TOOL_NAME } from "../tools/ask_user.ts";
import { dispatchMentionNotifications } from "../notifications/mentions.ts";
import { getUserById } from "../auth/users.ts";
import { listSkillsForProject } from "../memory/skills.ts";
import {
  buildSkillCatalog,
  loadSkillAssets,
  listSkillResources,
} from "../memory/skill_assets.ts";

const MAX_TOOL_ITERATIONS = 20;

/** Synthetic user-message inserted after the first reasoning-only turn so
 *  the model commits to a real answer or tool call on its retry. */
const EMPTY_RESPONSE_NUDGE =
  "(Note from the runtime: your previous turn produced no visible answer and no tool call. Please respond now with either a final answer in the normal output channel, or a real tool call via the tools API. Do not embed your answer or tool calls inside reasoning / <think> blocks.)";

/** Operator-facing message when the model still produces nothing after a
 *  nudge. The optional reasoning preview hints at what the model "thought"
 *  while staying silent. */
function emptyResponseError(reasoningPreview: string): string {
  const suffix = reasoningPreview
    ? ` Reasoning preview: ${reasoningPreview}…`
    : "";
  return `Model returned no visible answer in this turn — try regenerating or rephrasing.${suffix}`;
}

const SKILL_CATALOG_TTL_MS = 30_000;
const skillCatalogCache = new Map<
  string,
  { catalog: ReturnType<typeof buildSkillCatalog>; ts: number }
>();

// Tool names whose handlers live on per-run closures, not the singleton.
// Scrubbed from the agent's static whitelist before `subset()` so they don't
// get silently dropped (subset only copies tools that actually exist on the
// base registry; these are added via `extras` below).
const DYNAMIC_TOOL_NAMES = new Set<string>([
  CALL_AGENT_TOOL_NAME,
  ACTIVATE_SKILL_TOOL_NAME,
  ASK_USER_TOOL_NAME,
  ...BOARD_TOOL_NAMES,
  ...WORKSPACE_TOOL_NAMES,
  ...WEB_TOOL_NAMES,
]);

export interface RunAgentOptions {
  prompt: string;
  /** Optional images attached to this user turn (OpenAI-style multipart content). */
  attachments?: ChatAttachment[];
  sessionId: string;
  /** Owning user id — stamped onto every message/event produced this turn. */
  userId?: string;
  /** Owning project. Defaults to `agentCfg.defaultProject` / 'general' when omitted. */
  project?: string;
  /**
   * When set, the turn is run *as* this named agent. The agent's system prompt,
   * tool whitelist, and memory knobs override the project defaults, and every
   * message/SSE event is stamped with this author name.
   */
  agent?: string;
  /** Internal — depth in the agent-call chain. 0 for user-facing turns. */
  callDepth?: number;
  llmCfg: LlmConfig;
  embedCfg: EmbedConfig;
  memoryCfg: MemoryConfig;
  /** Optional — carries the base system prompt + default project name from config. */
  agentCfg?: AgentConfig;
  tools: ToolRegistry;
  db: Database;
  queue: BunnyQueue;
  renderer: Renderer;
  /** Web tool config (SERP keys, user-agent). Web tools are disabled when omitted. */
  webCfg?: WebConfig;
  /** Telegram runtime config — when set, successful mention notifications
   *  also fan out to the recipient's linked Telegram chat. Only pass this
   *  from code paths where outbound pushes are desired (`POST /api/chat`). */
  telegramCfg?: TelegramConfig;
  /** When set, replaces the entire system prompt (skips project/agent/recall prompt building). */
  systemPromptOverride?: string;
  /** Regenerate path: the prompt is already in the DB; don't insert it again. */
  skipUserInsert?: boolean;
  /** Stamp `regen_of_message_id` on the first assistant content row produced
   *  by this run (multi-step continuations are NOT chained). */
  regenOfMessageId?: number;
  /** Expose the `ask_user` tool to the model for this run. Only set this on
   *  code paths whose renderer *and* front-end can round-trip a user answer
   *  back into the blocked tool — currently `/api/chat` and
   *  `/api/messages/:id/regenerate`. Leaving it off (the default) keeps the
   *  tool hidden from edit-mode handlers (whiteboards, documents, KB, contacts)
   *  and from background card / scheduler runs where a blocking question
   *  would just time out unanswered. */
  askUserEnabled?: boolean;
  /** Scan the user turn for `@username` mentions and create notifications.
   *  Only `POST /api/chat` sets this. Regenerate and every background code
   *  path leave it off so edits / re-runs don't re-fire pings. See ADR 0027. */
  mentionsEnabled?: boolean;
}

/** Run one user turn through the agent loop. Returns the final assistant response. */
export async function runAgent(opts: RunAgentOptions): Promise<string> {
  const {
    prompt,
    attachments,
    sessionId,
    userId,
    llmCfg,
    embedCfg,
    memoryCfg,
    agentCfg,
    tools,
    db,
    queue,
    renderer,
  } = opts;
  const project = opts.project ?? agentCfg?.defaultProject ?? DEFAULT_PROJECT;
  const callDepth = opts.callDepth ?? 0;

  // One project per session.
  const existingProject = getSessionProject(db, sessionId);
  if (existingProject !== null && existingProject !== project) {
    throw new Error(
      `session '${sessionId}' belongs to project '${existingProject}', cannot run under '${project}'`,
    );
  }

  // Resolve agent (if any). The agent must exist and be linked to the project.
  const agentName = opts.agent ?? null;
  const agentRow = agentName ? getAgent(db, agentName) : null;
  if (agentName && !agentRow) {
    throw new Error(`agent '${agentName}' does not exist`);
  }
  if (agentName && !isAgentLinkedToProject(db, project, agentName)) {
    throw new Error(
      `agent '${agentName}' is not available in project '${project}'`,
    );
  }
  const agentAssets = agentName ? loadAgentAssets(agentName) : undefined;

  const projectAssets = loadProjectAssets(project);
  const effectiveLastN =
    agentAssets?.memory.lastN ?? projectAssets.memory.lastN ?? memoryCfg.lastN;
  const effectiveRecallK =
    agentAssets?.memory.recallK ??
    projectAssets.memory.recallK ??
    memoryCfg.recallK;

  // Context scoping: an agent in "own" mode only sees its own prior assistant
  // rows (+ user turns). Default assistant and "full" agents see everything.
  const ownAuthor: string | null | undefined =
    agentRow?.contextScope === "own" ? agentName : undefined;

  const recentTurns = getRecentTurns(db, sessionId, effectiveLastN, ownAuthor);
  const recentIds = new Set(recentTurns.map((t) => t.messageId));

  const recall = await hybridRecall(
    db,
    embedCfg,
    prompt,
    effectiveRecallK,
    sessionId,
    project,
    recentIds,
    ownAuthor,
  ).catch(() => []);

  // Peer list for the `knows_other_agents` prompt section.
  let otherAgents: PeerAgentDescriptor[] | undefined;
  if (agentRow?.knowsOtherAgents) {
    otherAgents = listAgentsForProject(db, project)
      .filter((a) => a.name !== agentName)
      .map((a) => ({ name: a.name, description: a.description }));
  }

  const now = Date.now();
  const cachedSkills = skillCatalogCache.get(project);
  let skillCatalog: ReturnType<typeof buildSkillCatalog> | undefined;
  let projectSkills: { name: string }[];
  if (cachedSkills && now - cachedSkills.ts < SKILL_CATALOG_TTL_MS) {
    skillCatalog =
      cachedSkills.catalog.length > 0 ? cachedSkills.catalog : undefined;
    projectSkills = cachedSkills.catalog;
  } else {
    const skills = listSkillsForProject(db, project);
    const catalog = skills.length > 0 ? buildSkillCatalog(skills) : [];
    skillCatalogCache.set(project, { catalog, ts: now });
    skillCatalog = catalog.length > 0 ? catalog : undefined;
    projectSkills = catalog;
  }

  const askUserAvailable = Boolean(
    opts.askUserEnabled && renderer.onAskUserQuestion,
  );
  // Load the speaking user once, then reuse for memory injection, the prompt
  // section header, and the mention scanner below. systemPromptOverride
  // callers (KB generation, doc edit, code edit, the memory-refresh handler
  // itself, …) bypass memory injection so their fixed prompts stay
  // deterministic and the soul of the system user doesn't feed back into a
  // memory-curation run.
  const currentUser =
    userId && !opts.systemPromptOverride ? getUserById(db, userId) : null;
  const memoryContext = opts.systemPromptOverride
    ? { userSoul: "", userMemory: "", agentProjectMemory: "" }
    : loadMemoryContext(db, {
        userId: userId ?? null,
        project,
        agent: agentName,
        userRow: currentUser,
      });
  const userDisplay =
    currentUser?.displayName?.trim() || currentUser?.username || undefined;
  const systemMsg = opts.systemPromptOverride
    ? { role: "system" as const, content: opts.systemPromptOverride }
    : buildSystemMessage({
        recall,
        projectAssets,
        baseSystem: agentCfg?.systemPrompt,
        agentAssets,
        agentName: agentName ?? undefined,
        agentDescription: agentRow?.description,
        otherAgents,
        skillCatalog,
        askUserAvailable,
        userSoul: memoryContext.userSoul,
        userMemory: memoryContext.userMemory,
        agentProjectMemory: memoryContext.agentProjectMemory,
        userDisplay,
        project,
      });

  if (!opts.skipUserInsert) {
    const userMsgId = insertMessage(db, {
      sessionId,
      userId,
      project,
      role: "user",
      content: prompt,
      attachments: attachments && attachments.length > 0 ? attachments : null,
      // User turns are always stamped as null — `author` means "who wrote
      // this", not "who it was addressed to". Recall / `getRecentTurns` still
      // include user rows unconditionally when a scope is set.
      author: null,
    });
    void indexMessage(db, embedCfg, userMsgId, prompt);
    void queue.log({
      topic: "memory",
      kind: "index",
      sessionId,
      userId,
      data: { role: "user", agent: agentName },
    });

    // Scan for @username mentions and fire notifications. Gated by
    // `mentionsEnabled` so only /api/chat does this (regenerate + every
    // background path leave it off — see ADR 0027). Reuses `currentUser`
    // when it was already loaded for memory injection above; falls back to a
    // direct lookup for systemPromptOverride callers (which skip memory).
    if (opts.mentionsEnabled && userId) {
      const sender = currentUser ?? getUserById(db, userId);
      if (sender) {
        try {
          dispatchMentionNotifications({
            db,
            queue,
            project,
            sessionId,
            messageId: userMsgId,
            sender,
            rawPrompt: prompt,
            telegramCfg: opts.telegramCfg,
          });
        } catch (err) {
          void queue.log({
            topic: "notification",
            kind: "dispatch.error",
            sessionId,
            userId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  const userMessage: ChatMessage = { role: "user", content: prompt };
  if (attachments && attachments.length > 0)
    userMessage.attachments = attachments;

  const messages: ChatMessage[] = [
    systemMsg,
    ...recentTurns.map((t) => {
      const m: ChatMessage = { role: t.role, content: t.content };
      if (t.attachments && t.attachments.length > 0)
        m.attachments = t.attachments;
      return m;
    }),
    userMessage,
  ];

  const skillNames = projectSkills.map((s) => s.name);

  // Per-run registry: agent's whitelist plus closure-bound extras
  // (`call_agent` when subagents are allowed, board tools always).
  const runTools = buildRunRegistry({
    baseTools: tools,
    agentAssets,
    callDepth,
    boardCtx: { db, project, userId: userId ?? "system" },
    skillNames,
    webCfg: opts.webCfg,
    askUserCtx: askUserAvailable
      ? {
          sessionId,
          author: agentName ?? undefined,
          emit: (ev) => renderer.onAskUserQuestion?.(ev),
        }
      : undefined,
    invokeSubagent: async (subName, subPrompt) => {
      // Subagents run with a silent renderer so only their final answer
      // reaches the UI via the `call_agent` tool_result — no parent-labelled
      // deltas from a child run.
      return runAgent({
        ...opts,
        prompt: subPrompt,
        agent: subName,
        callDepth: callDepth + 1,
        renderer: silentRenderer(),
      });
    },
  });

  let iterations = 0;
  let pendingRegenOfMessageId: number | null = opts.regenOfMessageId ?? null;
  // True after we've already nudged the model once for emitting an empty
  // response with no tool calls. A second empty turn surfaces an error
  // instead of looping forever.
  let emptyResponseNudged = false;
  const gate = ensureGlobalGate(llmCfg.maxConcurrentRequests);

  while (iterations++ < MAX_TOOL_ITERATIONS) {
    const toolSchemas = runTools.list();
    void queue.log({
      topic: "llm",
      kind: "request",
      sessionId,
      userId,
      data: {
        model: llmCfg.model,
        agent: agentName,
        messageCount: messages.length,
        toolCount: toolSchemas.length,
        systemPromptLength: (systemMsg.content ?? "").length,
        messages,
        tools: toolSchemas.length > 0 ? toolSchemas : undefined,
      },
    });
    const t0 = Date.now();
    const { deltas, response } = await chat(
      llmCfg,
      {
        messages,
        tools: toolSchemas.length > 0 ? toolSchemas : undefined,
      },
      {
        gate,
        onQueueWait: (ev) => renderer.onQueueWait?.({ position: ev.position }),
        onQueueRelease: (ev) =>
          renderer.onQueueRelease?.({ waitedMs: ev.waitedMs }),
      },
    );

    for await (const delta of deltas) {
      renderer.onDelta(delta);
    }

    const llmRes = await response;
    const durationMs = Date.now() - t0;

    const assistantContent = llmRes.message.content ?? "";
    void queue.log({
      topic: "llm",
      kind: "response",
      sessionId,
      userId,
      data: {
        agent: agentName,
        promptTokens: llmRes.usage?.promptTokens,
        completionTokens: llmRes.usage?.completionTokens,
        toolCalls:
          llmRes.message.tool_calls?.map((tc) => tc.function.name) ?? [],
        contentPreview: assistantContent
          ? truncate(assistantContent, 2048)
          : undefined,
        message: llmRes.message,
      },
      durationMs,
    });
    const stats = {
      durationMs,
      promptTokens: llmRes.usage?.promptTokens,
      completionTokens: llmRes.usage?.completionTokens,
    };
    if (llmRes.message.reasoning) {
      insertMessage(db, {
        sessionId,
        userId,
        project,
        role: "assistant",
        channel: "reasoning",
        content: llmRes.message.reasoning,
        author: agentName ?? null,
      });
    }
    if (assistantContent) {
      const aid = insertMessage(db, {
        sessionId,
        userId,
        project,
        role: "assistant",
        channel: "content",
        content: assistantContent,
        author: agentName ?? null,
        regenOfMessageId: pendingRegenOfMessageId,
        ...stats,
      });
      // Only the FIRST assistant content row in this run is part of the
      // regen chain. Tool-step continuations write fresh assistant rows.
      pendingRegenOfMessageId = null;
      void indexMessage(db, embedCfg, aid, assistantContent);
    }
    renderer.onStats(stats);

    messages.push(llmRes.message);

    const toolCalls = llmRes.message.tool_calls ?? [];
    if (toolCalls.length === 0 && assistantContent.trim()) {
      renderer.onTurnEnd();
      return assistantContent;
    }
    if (toolCalls.length === 0) {
      // Reasoning-mode models occasionally route their entire turn —
      // would-be answer + any tool call — through the reasoning channel,
      // leaving us with empty content and no tool calls. Pop the empty
      // turn we just pushed, nudge once, and retry. Still empty next
      // time → surface a clear error so the chat doesn't hang silent.
      messages.pop();
      if (!emptyResponseNudged) {
        emptyResponseNudged = true;
        messages.push({ role: "user", content: EMPTY_RESPONSE_NUDGE });
        continue;
      }
      const preview = (llmRes.message.reasoning ?? "").trim().slice(0, 240);
      renderer.onError(emptyResponseError(preview));
      renderer.onTurnEnd();
      return "";
    }
    // Non-empty turn — reset the flag so a later empty turn in the same
    // run still gets its one retry.
    emptyResponseNudged = false;

    for (const tc of toolCalls) {
      insertMessage(db, {
        sessionId,
        userId,
        project,
        role: "assistant",
        channel: "tool_call",
        content: tc.function.arguments,
        toolCallId: tc.id,
        toolName: tc.function.name,
        author: agentName ?? null,
      });
    }

    const toolResults = await Promise.all(
      toolCalls.map(async (tc) => {
        void queue.log({
          topic: "tool",
          kind: "call",
          sessionId,
          userId,
          data: {
            name: tc.function.name,
            agent: agentName,
            args: truncate(tc.function.arguments, 2048),
          },
        });
        const t1 = Date.now();
        const result = await runTools.call(
          tc.function.name,
          tc.function.arguments,
        );
        void queue.log({
          topic: "tool",
          kind: "result",
          sessionId,
          userId,
          data: {
            name: tc.function.name,
            ok: result.ok,
            agent: agentName,
            output: truncate(result.output, 2048),
          },
          durationMs: Date.now() - t1,
          error: result.ok ? undefined : result.error,
        });
        return { tc, result };
      }),
    );

    for (const { tc, result } of toolResults) {
      renderer.onToolResult(tc.function.name, result);
      messages.push({
        role: "tool",
        content: result.output,
        tool_call_id: tc.id,
      });
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
        author: agentName ?? null,
      });
    }
  }

  renderer.onError("Max tool iterations reached — stopping agent loop.");
  return "(agent stopped: too many tool calls)";
}

interface BuildRunRegistryOpts {
  baseTools: ToolRegistry;
  agentAssets:
    | { tools: string[] | undefined; allowedSubagents: string[] }
    | undefined;
  callDepth: number;
  boardCtx: BoardToolContext;
  skillNames: string[];
  webCfg?: WebConfig;
  invokeSubagent: (name: string, prompt: string) => Promise<string>;
  askUserCtx?: {
    sessionId: string;
    author?: string;
    emit: (ev: import("./sse_events.ts").SseAskUserQuestionEvent) => void;
  };
}

function buildRunRegistry(opts: BuildRunRegistryOpts): ToolRegistry {
  const { baseTools, agentAssets } = opts;
  const whitelist = agentAssets?.tools; // undefined = all tools
  const allowedSubagents = agentAssets?.allowedSubagents ?? [];

  const extras: ToolDescriptor[] = [];
  const allBoard = makeBoardTools(opts.boardCtx);
  const allWorkspace = makeWorkspaceTools({ project: opts.boardCtx.project });
  const allWeb = opts.webCfg
    ? makeWebTools({ project: opts.boardCtx.project, webCfg: opts.webCfg })
    : [];
  if (whitelist) {
    const allow = new Set(whitelist);
    for (const t of allBoard) if (allow.has(t.name)) extras.push(t);
    for (const t of allWorkspace) if (allow.has(t.name)) extras.push(t);
    for (const t of allWeb) if (allow.has(t.name)) extras.push(t);
  } else {
    extras.push(...allBoard);
    extras.push(...allWorkspace);
    extras.push(...allWeb);
  }

  if (allowedSubagents.length > 0) {
    extras.push(
      makeCallAgentTool({
        allowed: allowedSubagents,
        depth: opts.callDepth,
        invoke: opts.invokeSubagent,
      }),
    );
  }

  if (
    opts.skillNames.length > 0 &&
    (!whitelist || whitelist.includes(ACTIVATE_SKILL_TOOL_NAME))
  ) {
    extras.push(
      makeActivateSkillTool({
        available: opts.skillNames,
        loadInstructions: (name) => {
          const assets = loadSkillAssets(name);
          const resources = listSkillResources(name);
          return { instructions: assets.instructions, resources };
        },
      }),
    );
  }

  if (
    opts.askUserCtx &&
    (!whitelist || whitelist.includes(ASK_USER_TOOL_NAME))
  ) {
    extras.push(
      makeAskUserTool({
        sessionId: opts.askUserCtx.sessionId,
        author: opts.askUserCtx.author,
        emit: opts.askUserCtx.emit,
      }),
    );
  }

  const filtered = whitelist
    ? whitelist.filter((n) => !DYNAMIC_TOOL_NAMES.has(n))
    : undefined;
  return baseTools.subset(filtered, extras);
}

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
    /* non-fatal */
  }
}
