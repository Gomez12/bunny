/**
 * On-disk assets that augment a project's agent behaviour.
 *
 * Each project has a directory under `$BUNNY_HOME/projects/<name>/`. Today we
 * read a single `systemprompt.toml` — future additions (skills.md,
 * shortcuts.toml, wiki/) will land alongside it and be aggregated through
 * {@link loadProjectAssets}.
 *
 * The TOML file is the source of truth for the prompt text; the DB row only
 * stores metadata.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../paths.ts";
import { validateProjectName } from "./projects.ts";

export interface ProjectSystemPrompt {
  /** Free text added to (or replacing) the base system prompt. */
  prompt: string;
  /** true = append to base, false = fully replace. Default true. */
  append: boolean;
}

/**
 * Per-project memory overrides. Any field left `null` means "inherit from the
 * global `[memory]` block in `bunny.config.toml`". Stored inline in the
 * project's `systemprompt.toml` so a single file captures all runtime tuning.
 */
export interface ProjectMemoryOverrides {
  lastN: number | null;
  recallK: number | null;
}

export interface ProjectAssets {
  systemPrompt: ProjectSystemPrompt;
  memory: ProjectMemoryOverrides;
}

const SYSTEMPROMPT_FILE = "systemprompt.toml";

export function projectDir(name: string): string {
  return paths.projectDir(validateProjectName(name));
}

/**
 * A single file on disk (`systemprompt.toml`) carries both the system-prompt
 * text and the per-project memory overrides. A partial patch can touch one
 * concern without clobbering the other.
 */
export interface ProjectOverridesPatch {
  systemPrompt?: Partial<ProjectSystemPrompt>;
  memory?: Partial<ProjectMemoryOverrides>;
}

const DEFAULT_SYSTEM_PROMPT: ProjectSystemPrompt = { prompt: "", append: true };
const DEFAULT_MEMORY: ProjectMemoryOverrides = { lastN: null, recallK: null };

/** Create the on-disk project directory (and a stub systemprompt.toml) if missing. */
export function ensureProjectDir(name: string, initial?: ProjectOverridesPatch): string {
  const dir = projectDir(name);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = join(dir, SYSTEMPROMPT_FILE);
  if (!existsSync(file)) {
    writeFileSync(
      file,
      renderSystemPromptToml(
        { ...DEFAULT_SYSTEM_PROMPT, ...(initial?.systemPrompt ?? {}) },
        { ...DEFAULT_MEMORY, ...(initial?.memory ?? {}) },
      ),
      "utf8",
    );
  }
  return dir;
}

/** Overwrite the systemprompt.toml file for a project. Creates the directory if needed. */
export function writeProjectSystemPrompt(
  name: string,
  sp: Partial<ProjectSystemPrompt>,
  memory?: Partial<ProjectMemoryOverrides>,
): void {
  const dir = projectDir(name);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const current = loadProjectAssets(name);
  writeFileSync(
    join(dir, SYSTEMPROMPT_FILE),
    renderSystemPromptToml(
      { ...current.systemPrompt, ...sp },
      memory === undefined ? current.memory : { ...current.memory, ...memory },
    ),
    "utf8",
  );
}

/** Read systemprompt.toml. Returns defaults when missing or malformed. */
export function loadProjectSystemPrompt(name: string): ProjectSystemPrompt {
  return loadProjectAssets(name).systemPrompt;
}

/** Aggregate all per-project on-disk assets into a single value. */
export function loadProjectAssets(name: string): ProjectAssets {
  const file = join(projectDir(name), SYSTEMPROMPT_FILE);
  if (!existsSync(file)) {
    return { systemPrompt: { ...DEFAULT_SYSTEM_PROMPT }, memory: { ...DEFAULT_MEMORY } };
  }
  try {
    const text = readFileSync(file, "utf8");
    const parsed = Bun.TOML.parse(text) as {
      prompt?: unknown;
      append?: unknown;
      last_n?: unknown;
      recall_k?: unknown;
    };
    const prompt = typeof parsed.prompt === "string" ? parsed.prompt : "";
    const append = parsed.append === undefined ? true : Boolean(parsed.append);
    return {
      systemPrompt: { prompt, append },
      memory: { lastN: parseOverride(parsed.last_n), recallK: parseOverride(parsed.recall_k) },
    };
  } catch {
    return { systemPrompt: { ...DEFAULT_SYSTEM_PROMPT }, memory: { ...DEFAULT_MEMORY } };
  }
}

function parseOverride(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return null;
  return Math.floor(raw);
}

function renderSystemPromptToml(
  sp: Partial<ProjectSystemPrompt>,
  memory: Partial<ProjectMemoryOverrides> = {},
): string {
  const prompt = sp.prompt ?? "";
  const append = sp.append === undefined ? true : sp.append;
  // Escape closing triple-quotes defensively.
  const escaped = prompt.replace(/"""/g, '\\"\\"\\"');

  const memoryLines: string[] = [];
  if (typeof memory.lastN === "number") memoryLines.push(`last_n = ${Math.floor(memory.lastN)}`);
  if (typeof memory.recallK === "number") memoryLines.push(`recall_k = ${Math.floor(memory.recallK)}`);
  const memoryBlock = memoryLines.length
    ? `\n# Per-project memory overrides — omit a line to inherit from the\n# global [memory] block in bunny.config.toml.\n${memoryLines.join("\n")}\n`
    : `\n# Optional per-project memory overrides — inherit globals by default.\n# last_n  = 10   # verbatim short-term turns replayed each request\n# recall_k = 8   # BM25+kNN hits injected into the system prompt\n`;

  return `# Project configuration — edit freely.
# append = true  → this text is added after the base system prompt (recommended).
# append = false → this text fully replaces the base system prompt.

append = ${append ? "true" : "false"}
${memoryBlock}
prompt = """
${escaped}
"""
`;
}
