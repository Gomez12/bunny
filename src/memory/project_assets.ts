/**
 * On-disk assets for a project: one `systemprompt.toml` under
 * `$BUNNY_HOME/projects/<name>/` carrying the prompt text + per-project memory
 * overrides. The DB row stores metadata; this file is the source of truth for
 * prompt content and tuning.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
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
 * Per-project memory overrides. A `null` field means "inherit the global
 * `[memory]` value in `bunny.config.toml`".
 */
export interface ProjectMemoryOverrides {
  lastN: number | null;
  recallK: number | null;
}

export interface ProjectAssets {
  systemPrompt: ProjectSystemPrompt;
  memory: ProjectMemoryOverrides;
}

export interface ProjectOverridesPatch {
  systemPrompt?: Partial<ProjectSystemPrompt>;
  memory?: Partial<ProjectMemoryOverrides>;
}

const SYSTEMPROMPT_FILE = "systemprompt.toml";

const DEFAULT_SYSTEM_PROMPT: ProjectSystemPrompt = { prompt: "", append: true };
const DEFAULT_MEMORY: ProjectMemoryOverrides = { lastN: null, recallK: null };

export function projectDir(name: string): string {
  return paths.projectDir(validateProjectName(name));
}

/** Root of the per-project file workspace (`<projectDir>/workspace`). */
export function workspaceDir(name: string): string {
  return join(projectDir(name), "workspace");
}

/** Default subdirectories created inside every workspace. */
export const WORKSPACE_DEFAULT_SUBDIRS = ["input", "output"] as const;

/** Create the on-disk project directory (and a stub systemprompt.toml) if missing. */
export function ensureProjectDir(name: string, initial?: ProjectOverridesPatch): string {
  const dir = projectDir(name);
  mkdirSync(dir, { recursive: true });
  // Seed workspace + its default subdirs. Idempotent — mkdir recursive skips
  // existing paths, so this also backfills legacy projects on the next access.
  for (const sub of WORKSPACE_DEFAULT_SUBDIRS) {
    mkdirSync(join(dir, "workspace", sub), { recursive: true });
  }
  const file = join(dir, SYSTEMPROMPT_FILE);
  // Never clobber an existing prompt file — only seed the stub on first create.
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
  mkdirSync(dir, { recursive: true });
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

/** mtime-keyed cache so runAgent doesn't re-read + re-parse on every turn. */
const assetsCache = new Map<string, { mtimeMs: number; assets: ProjectAssets }>();

/** Aggregate all per-project on-disk assets into a single value. */
export function loadProjectAssets(name: string): ProjectAssets {
  const file = join(projectDir(name), SYSTEMPROMPT_FILE);
  let mtimeMs = -1;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    // File may not exist — fall through to defaults below.
  }
  const hit = assetsCache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.assets;
  if (mtimeMs < 0) {
    const defaults: ProjectAssets = {
      systemPrompt: { ...DEFAULT_SYSTEM_PROMPT },
      memory: { ...DEFAULT_MEMORY },
    };
    return defaults;
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
    const assets: ProjectAssets = {
      systemPrompt: { prompt, append },
      memory: {
        lastN: parseMemoryOverride(parsed.last_n),
        recallK: parseMemoryOverride(parsed.recall_k),
      },
    };
    assetsCache.set(file, { mtimeMs, assets });
    return assets;
  } catch {
    // Malformed TOML → defaults (non-fatal). Don't cache so a fix takes effect.
    return { systemPrompt: { ...DEFAULT_SYSTEM_PROMPT }, memory: { ...DEFAULT_MEMORY } };
  }
}

/**
 * Normalise an incoming memory override value. Accepts JSON numbers and
 * number-like strings; returns `null` for anything else (blank, negative,
 * NaN, non-numeric) so "invalid" and "inherit global" map to the same state.
 */
export function parseMemoryOverride(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

function renderSystemPromptToml(
  sp: Partial<ProjectSystemPrompt>,
  memory: Partial<ProjectMemoryOverrides> = {},
): string {
  const prompt = sp.prompt ?? "";
  const append = sp.append === undefined ? true : sp.append;
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
