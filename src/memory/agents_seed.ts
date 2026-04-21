/**
 * Seed the configured default agent and link it to every existing project.
 *
 * Idempotent — safe to call on every boot. Operator edits to the on-disk
 * `config.toml` are preserved (the writer is a no-op when the file already
 * exists). Invalid configuration (malformed agent name) is warned, not fatal:
 * we never want a name typo to block a boot.
 *
 * Invariant: the configured default agent is the fallback responding agent
 * for every chat turn. `/api/chat` resolves to this name when the caller
 * doesn't pass an `agent` field and the prompt has no leading `@mention`.
 * See ADR 0031.
 */

import type { Database } from "bun:sqlite";
import type { AgentConfig } from "../config.ts";
import type { BunnyQueue } from "../queue/bunqueue.ts";
import { errorMessage } from "../util/error.ts";
import { getSystemUserId } from "../auth/seed.ts";
import {
  createAgent,
  getAgent,
  linkAgentToProject,
  listProjectsForAgent,
  validateAgentName,
} from "./agents.ts";
import { ensureAgentDir } from "./agent_assets.ts";
import { listProjects } from "./projects.ts";

const DEFAULT_AGENT_DESCRIPTION = "Bunny — the default assistant.";
const DEFAULT_AGENT_PROMPT = "You are a helpful assistant";

export function ensureDefaultAgent(
  db: Database,
  cfg: AgentConfig,
  queue: BunnyQueue,
): void {
  let name: string;
  try {
    name = validateAgentName(cfg.defaultAgent);
  } catch (e) {
    console.warn(
      `[bunny] invalid [agent].default_agent '${cfg.defaultAgent}': ${errorMessage(e)}`,
    );
    return;
  }

  try {
    const existing = getAgent(db, name);
    if (!existing) {
      createAgent(db, {
        name,
        description: DEFAULT_AGENT_DESCRIPTION,
        visibility: "public",
        isSubagent: false,
        knowsOtherAgents: false,
        contextScope: "full",
        createdBy: getSystemUserId(db),
      });
    }

    // `ensureAgentDir` only writes config.toml when it's missing, so operator
    // edits survive subsequent boots.
    ensureAgentDir(name, {
      systemPrompt: { prompt: DEFAULT_AGENT_PROMPT, append: true },
    });

    const before = new Set(listProjectsForAgent(db, name));
    const projects = listProjects(db);
    let linked = 0;
    for (const p of projects) {
      if (!before.has(p.name)) {
        linkAgentToProject(db, p.name, name);
        linked += 1;
      }
    }

    void queue.log({
      topic: "agent",
      kind: "seed.default",
      data: {
        agent: name,
        created: !existing,
        linkedProjects: linked,
        totalProjects: projects.length,
      },
    });
  } catch (e) {
    console.warn(`[bunny] ensureDefaultAgent failed: ${errorMessage(e)}`);
  }
}
