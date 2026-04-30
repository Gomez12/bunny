/**
 * Helpers shared by `runAgent` (prompt injection) and `memory.refresh` (the
 * hourly handler). Kept in a separate module so the agent loop and the
 * scheduler don't import each other's heavy dependencies.
 */

import type { Database } from "bun:sqlite";
import { getUserById, type User } from "../auth/users.ts";
import { getUserProjectMemory } from "./user_project_memory.ts";
import { getAgentProjectMemory } from "./agent_project_memory.ts";

/**
 * Three free-text strings spliced into the system prompt right after the
 * agent / project header. All three may be empty — the prompt section is
 * suppressed entirely when nothing is known.
 */
export interface MemoryContext {
  /** User soul body — global per user (personality + style). */
  userSoul: string;
  /** Per-(user, project) memory body — facts about THIS user in THIS project. */
  userMemory: string;
  /** Per-(agent, project) memory body — what THIS agent has accumulated for THIS project. */
  agentProjectMemory: string;
}

const EMPTY: MemoryContext = {
  userSoul: "",
  userMemory: "",
  agentProjectMemory: "",
};

/**
 * Best-effort read of the three memory bodies for a given runAgent invocation.
 *
 * Pass `userRow` when the caller already loaded it (the agent loop does, to
 * avoid hitting the users table twice in the same turn). Failures (missing
 * rows, FK gaps, malformed columns) collapse to empty strings so an
 * unhealthy memory store never blocks a chat reply.
 */
export function loadMemoryContext(
  db: Database,
  opts: {
    userId?: string | null;
    project: string;
    agent?: string | null;
    userRow?: User | null;
  },
): MemoryContext {
  const out: MemoryContext = { ...EMPTY };
  try {
    if (opts.userId) {
      const u =
        opts.userRow !== undefined ? opts.userRow : getUserById(db, opts.userId);
      if (u && u.soul) out.userSoul = u.soul;
      const upm = getUserProjectMemory(db, opts.userId, opts.project);
      if (upm && upm.memory) out.userMemory = upm.memory;
    }
    if (opts.agent) {
      const apm = getAgentProjectMemory(db, opts.agent, opts.project);
      if (apm && apm.memory) out.agentProjectMemory = apm.memory;
    }
  } catch {
    // Swallow — memory injection must never break the chat path.
  }
  return out;
}
