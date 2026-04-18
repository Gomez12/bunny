/**
 * On-disk assets for an agent: one `config.toml` under
 * `$BUNNY_HOME/agents/<name>/` carrying the system prompt, tool whitelist,
 * allowed-subagents list, and per-agent memory overrides.
 *
 * Mirrors {@link ./project_assets.ts}. The DB row stores metadata; this file
 * is the source of truth for prompt content and tuning.
 */

import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { paths } from "../paths.ts";
import { validateAgentName } from "./agents.ts";
import { parseMemoryOverride } from "./project_assets.ts";

export interface AgentSystemPrompt {
  prompt: string;
  /** true = append to base, false = fully replace. Default false for agents
   *  because an agent's identity is usually the whole prompt. */
  append: boolean;
}

export interface AgentMemoryOverrides {
  lastN: number | null;
  recallK: number | null;
}

export interface AgentAssets {
  systemPrompt: AgentSystemPrompt;
  memory: AgentMemoryOverrides;
  /**
   * Tool whitelist. `undefined` means "inherit all registered tools"; an empty
   * array means "no tools" (the agent may still receive `call_agent` if it
   * has allowed subagents).
   */
  tools: string[] | undefined;
  /** Names of agents this agent may invoke as subagent via `call_agent`. */
  allowedSubagents: string[];
}

export interface AgentOverridesPatch {
  systemPrompt?: Partial<AgentSystemPrompt>;
  memory?: Partial<AgentMemoryOverrides>;
  tools?: string[] | null;
  allowedSubagents?: string[];
}

const CONFIG_FILE = "config.toml";

const DEFAULT_SYSTEM_PROMPT: AgentSystemPrompt = { prompt: "", append: false };
const DEFAULT_MEMORY: AgentMemoryOverrides = { lastN: null, recallK: null };

export function agentDir(name: string): string {
  return paths.agentDir(validateAgentName(name));
}

/** Create the on-disk agent directory (and a stub config.toml) if missing. */
export function ensureAgentDir(
  name: string,
  initial?: AgentOverridesPatch,
): string {
  const dir = agentDir(name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, CONFIG_FILE);
  if (!existsSync(file)) {
    writeFileSync(
      file,
      renderConfigToml(
        { ...DEFAULT_SYSTEM_PROMPT, ...(initial?.systemPrompt ?? {}) },
        { ...DEFAULT_MEMORY, ...(initial?.memory ?? {}) },
        initial?.tools === null ? undefined : (initial?.tools ?? undefined),
        initial?.allowedSubagents ?? [],
      ),
      "utf8",
    );
  }
  return dir;
}

/** Overwrite the config.toml file for an agent. Creates the directory if needed. */
export function writeAgentAssets(
  name: string,
  patch: AgentOverridesPatch,
): void {
  const dir = agentDir(name);
  mkdirSync(dir, { recursive: true });
  const current = loadAgentAssets(name);
  const sp = { ...current.systemPrompt, ...(patch.systemPrompt ?? {}) };
  const memory =
    patch.memory === undefined
      ? current.memory
      : { ...current.memory, ...patch.memory };
  const tools =
    patch.tools === undefined
      ? current.tools
      : patch.tools === null
        ? undefined
        : [...patch.tools];
  const allowedSubagents = patch.allowedSubagents ?? current.allowedSubagents;
  writeFileSync(
    join(dir, CONFIG_FILE),
    renderConfigToml(sp, memory, tools, allowedSubagents),
    "utf8",
  );
}

/** mtime-keyed cache so runAgent doesn't re-read + re-parse on every turn. */
const assetsCache = new Map<string, { mtimeMs: number; assets: AgentAssets }>();

/** Read config.toml. Returns defaults when missing or malformed. */
export function loadAgentAssets(name: string): AgentAssets {
  const file = join(agentDir(name), CONFIG_FILE);
  let mtimeMs = -1;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    // Missing file — fall through to defaults below.
  }
  const hit = assetsCache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.assets;
  if (mtimeMs < 0) {
    return {
      systemPrompt: { ...DEFAULT_SYSTEM_PROMPT },
      memory: { ...DEFAULT_MEMORY },
      tools: undefined,
      allowedSubagents: [],
    };
  }
  try {
    const text = readFileSync(file, "utf8");
    const parsed = Bun.TOML.parse(text) as {
      prompt?: unknown;
      append?: unknown;
      last_n?: unknown;
      recall_k?: unknown;
      tools?: unknown;
      allowed_subagents?: unknown;
    };
    const prompt = typeof parsed.prompt === "string" ? parsed.prompt : "";
    const append = parsed.append === undefined ? false : Boolean(parsed.append);
    const assets: AgentAssets = {
      systemPrompt: { prompt, append },
      memory: {
        lastN: parseMemoryOverride(parsed.last_n),
        recallK: parseMemoryOverride(parsed.recall_k),
      },
      tools: parseStringList(parsed.tools),
      allowedSubagents: parseStringList(parsed.allowed_subagents) ?? [],
    };
    assetsCache.set(file, { mtimeMs, assets });
    return assets;
  } catch {
    return {
      systemPrompt: { ...DEFAULT_SYSTEM_PROMPT },
      memory: { ...DEFAULT_MEMORY },
      tools: undefined,
      allowedSubagents: [],
    };
  }
}

function parseStringList(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) return undefined;
  return raw
    .filter((x): x is string => typeof x === "string")
    .map((s) => s.trim())
    .filter(Boolean);
}

function renderConfigToml(
  sp: AgentSystemPrompt,
  memory: AgentMemoryOverrides,
  tools: string[] | undefined,
  allowedSubagents: string[],
): string {
  const append = sp.append ? "true" : "false";
  const escapedPrompt = sp.prompt.replace(/"""/g, '\\"\\"\\"');

  const memoryLines: string[] = [];
  if (typeof memory.lastN === "number")
    memoryLines.push(`last_n = ${Math.floor(memory.lastN)}`);
  if (typeof memory.recallK === "number")
    memoryLines.push(`recall_k = ${Math.floor(memory.recallK)}`);
  const memoryBlock = memoryLines.length
    ? `\n# Per-agent memory overrides — omit a line to inherit project / global value.\n${memoryLines.join("\n")}\n`
    : `\n# Optional per-agent memory overrides — inherit project/global by default.\n# last_n   = 10\n# recall_k = 8\n`;

  const toolsLine =
    tools === undefined
      ? `# tools = [] # whitelist — omit to inherit every registered tool\n`
      : `tools = [${tools.map(quote).join(", ")}]\n`;
  const subLine = `allowed_subagents = [${allowedSubagents.map(quote).join(", ")}]\n`;

  return `# Agent configuration — edit freely.
# append = true  → this text is added after the base system prompt.
# append = false → this text fully replaces the base system prompt (recommended for agents).

append = ${append}

${toolsLine}${subLine}${memoryBlock}
prompt = """
${escapedPrompt}
"""
`;
}

function quote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
