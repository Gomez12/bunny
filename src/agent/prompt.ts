/**
 * System prompt builder.
 *
 * Assembles the system message that is prepended to every conversation.
 * Injected recall context (past messages) is appended as a separate section.
 */

import type { ChatMessage } from "../llm/types.ts";
import type { RecallResult } from "../memory/recall.ts";

const BASE_SYSTEM = `You are Bunny, a helpful AI coding agent.

You have access to tools for reading, listing, and editing files in the working directory.
Use tools when you need to inspect or modify files. Think step-by-step before acting.
When you are done, reply with your final answer without making any more tool calls.`;

/** Build the system message, optionally including recalled context. */
export function buildSystemMessage(recall: RecallResult[] = []): ChatMessage {
  let content = BASE_SYSTEM;

  if (recall.length > 0) {
    const lines = recall
      .filter((r) => r.content)
      .map((r) => `- [session ${r.sessionId.slice(0, 8)}]: ${r.content}`)
      .join("\n");
    content += `\n\n## Relevant past context\n${lines}`;
  }

  return { role: "system", content };
}
