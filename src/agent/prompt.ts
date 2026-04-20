/**
 * System prompt builder.
 *
 * Assembles the system message that is prepended to every conversation.
 * Injected recall context (past messages) is appended as a separate section.
 */

import type { ChatMessage } from "../llm/types.ts";
import type { RecallResult } from "../memory/recall.ts";
import type { ProjectAssets } from "../memory/project_assets.ts";
import type { AgentAssets } from "../memory/agent_assets.ts";
import { resolvePrompt, interpolate } from "../prompts/resolve.ts";

/**
 * Fallback base system prompt used when callers don't pass one explicitly. In
 * production the prompt is sourced from `cfg.agent.systemPrompt`
 * (`[agent] system_prompt` in `bunny.config.toml`); this fallback exists so
 * unit tests and legacy callers still get a sensible default.
 */
const FALLBACK_BASE_SYSTEM = `You are Bunny, a helpful AI coding agent.

You have access to tools for reading, listing, and editing files in the working directory.
Use tools when you need to inspect or modify files. Think step-by-step before acting.
When you are done, reply with your final answer without making any more tool calls.`;

export interface PeerAgentDescriptor {
  name: string;
  description: string;
}

export interface SkillCatalogEntry {
  name: string;
  description: string;
}

export interface BuildSystemMessageOpts {
  recall?: RecallResult[];
  /** Per-project on-disk assets (systemprompt.toml etc.). */
  projectAssets?: ProjectAssets;
  /** Base system prompt. Defaults to {@link FALLBACK_BASE_SYSTEM}. */
  baseSystem?: string;
  /** When set, the prompt is built for this agent instead of the default assistant. */
  agentAssets?: AgentAssets;
  /** Agent name — used in the preamble when `agentAssets` is set. */
  agentName?: string;
  /** Agent description — folded into the preamble so the LLM knows its role
   *  even if the operator left the free-text prompt empty. */
  agentDescription?: string;
  /** Peer agents that the agent may mention. Only used when the agent opts in. */
  otherAgents?: PeerAgentDescriptor[];
  /** Skill catalog entries for progressive disclosure (tier 1: name + description). */
  skillCatalog?: SkillCatalogEntry[];
  /** True when the `ask_user` tool is spliced into the per-run registry.
   *  Adds a short instruction block so the model actually reaches for it on
   *  ambiguous / preference-driven prompts instead of guessing and going on. */
  askUserAvailable?: boolean;
}

/**
 * Build the system message.
 *
 * Accepts either a plain `RecallResult[]` (legacy positional call) or an
 * options object carrying both recall and project assets.
 */
export function buildSystemMessage(
  recallOrOpts: RecallResult[] | BuildSystemMessageOpts = [],
): ChatMessage {
  const opts: BuildSystemMessageOpts = Array.isArray(recallOrOpts)
    ? { recall: recallOrOpts }
    : recallOrOpts;
  const recall = opts.recall ?? [];
  const projectPrompt = opts.projectAssets?.systemPrompt;
  const agentPrompt = opts.agentAssets?.systemPrompt;
  const baseSystem = opts.baseSystem ?? FALLBACK_BASE_SYSTEM;

  // 1. When an agent is active, ALWAYS inject its identity — even when the
  //    operator left the free-text prompt empty. Otherwise the agent silently
  //    behaves like the default assistant while the UI shows its @-badge.
  //    `append=false` (default for agents) replaces the base stack; `append=true`
  //    layers the agent instructions on top of the project/base prompt.
  let content: string;
  if (opts.agentAssets && opts.agentName) {
    const agentBody = agentPrompt?.prompt.trim() ?? "";
    const header = buildAgentHeader(opts.agentName, opts.agentDescription);
    const identity = agentBody ? `${header}\n\n${agentBody}` : header;
    if (agentPrompt?.append) {
      content = buildProjectLayered(baseSystem, projectPrompt);
      content += `\n\n## Agent instructions\n${identity}`;
    } else {
      content = identity;
    }
  } else {
    // No agent → fall back to the existing project-layered behaviour.
    content = buildProjectLayered(baseSystem, projectPrompt);
  }

  if (opts.otherAgents && opts.otherAgents.length > 0) {
    const lines = opts.otherAgents
      .filter((a) => a.name && a.name !== opts.agentName)
      .map((a) => `- @${a.name} — ${a.description || "(no description)"}`)
      .join("\n");
    if (lines) {
      content += interpolate(resolvePrompt("agent.peer_agents_hint"), {
        lines,
      });
    }
  }

  if (opts.skillCatalog && opts.skillCatalog.length > 0) {
    const lines = opts.skillCatalog
      .map((s) => `- **${s.name}**: ${s.description}`)
      .join("\n");
    content += interpolate(resolvePrompt("agent.skill_catalog_hint"), {
      lines,
    });
  }

  if (opts.askUserAvailable) {
    content += resolvePrompt("agent.ask_user_hint");
  }

  if (recall.length > 0) {
    const lines = recall
      .filter((r) => r.content)
      .map((r) => `- [session ${r.sessionId.slice(0, 8)}]: ${r.content}`)
      .join("\n");
    content += `\n\n## Relevant past context\n${lines}`;
  }

  return { role: "system", content };
}

function buildAgentHeader(
  name: string,
  description: string | undefined,
): string {
  const desc = description?.trim();
  const lines = [
    `You are "${name}", a specialised agent.`,
    "Stay in character: your answers must reflect your name and remit, not a generic assistant.",
  ];
  if (desc) lines.push(`Your purpose: ${desc}`);
  return lines.join(" ");
}

function buildProjectLayered(
  baseSystem: string,
  projectPrompt: ProjectAssets["systemPrompt"] | undefined,
): string {
  const replace =
    projectPrompt &&
    projectPrompt.prompt.trim() !== "" &&
    projectPrompt.append === false;
  let content = replace ? projectPrompt.prompt : baseSystem;
  if (!replace && projectPrompt && projectPrompt.prompt.trim() !== "") {
    content += `\n\n## Project instructions\n${projectPrompt.prompt.trim()}`;
  }
  return content;
}
