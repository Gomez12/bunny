/**
 * Per-project prompt overrides — `prompts.toml` under
 * `$BUNNY_HOME/projects/<name>/`.
 *
 * Sibling of `systemprompt.toml` rather than a subtable: the prompts keyspace
 * grows (13 keys today, more as new handlers are extracted), and isolating
 * the file keeps the mtime cache clean + avoids rewriting the user's
 * hand-edited memory overrides on every prompt save.
 *
 * Lazy-seeded: the file is created the first time an override is written.
 * Projects that never override anything never own the file.
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  multilineTomlString,
  quoteKey,
  type PromptOverrides,
} from "../prompts/toml_utils.ts";
import { projectDir } from "./project_assets.ts";

export type ProjectPromptOverrides = PromptOverrides;

const PROMPTS_FILE = "prompts.toml";

interface CacheEntry {
  mtimeMs: number;
  overrides: ProjectPromptOverrides;
}

const cache = new Map<string, CacheEntry>();

function promptsPath(name: string): string {
  return join(projectDir(name), PROMPTS_FILE);
}

/**
 * Read the project's `prompts.toml`. Returns `{}` when the file is missing,
 * empty, or malformed. Non-string values are silently dropped. Cached by
 * mtime so `runAgent`-per-turn lookups stay cheap.
 */
export function loadProjectPromptOverrides(
  name: string,
): ProjectPromptOverrides {
  const file = promptsPath(name);
  let mtimeMs = -1;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    return {};
  }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.overrides;
  try {
    const text = readFileSync(file, "utf8");
    const parsed = Bun.TOML.parse(text) as Record<string, unknown>;
    const raw = (parsed["prompts"] as Record<string, unknown> | undefined) ?? {};
    const overrides: ProjectPromptOverrides = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === "string") overrides[k] = v;
    }
    cache.set(file, { mtimeMs, overrides });
    return overrides;
  } catch {
    return {};
  }
}

/**
 * Set one override. Passing `text: null` deletes the key (falls back to
 * global → registry default). Creates the file lazily on the first write.
 */
export function setProjectPromptOverride(
  name: string,
  key: string,
  text: string | null,
): void {
  const dir = projectDir(name);
  mkdirSync(dir, { recursive: true });
  const overrides = { ...loadProjectPromptOverrides(name) };
  if (text === null) {
    delete overrides[key];
  } else {
    overrides[key] = text;
  }
  const file = promptsPath(name);
  writeFileSync(file, renderPromptsToml(overrides), "utf8");
  cache.delete(file);
}

function renderPromptsToml(overrides: ProjectPromptOverrides): string {
  const keys = Object.keys(overrides).sort();
  if (keys.length === 0) {
    return `# Per-project prompt overrides.\n# Edit via the Project dialog in the web UI, or add entries here manually.\n# Keys without a value fall back to the global override (bunny.config.toml)\n# and then to the registry default.\n\n[prompts]\n`;
  }
  const lines: string[] = [
    "# Per-project prompt overrides.",
    "# Remove a key to fall back to the global / registry default.",
    "",
    "[prompts]",
  ];
  for (const k of keys) {
    lines.push(`${quoteKey(k)} = ${multilineTomlString(overrides[k]!)}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Test helper. */
export function __clearProjectPromptsCache(): void {
  cache.clear();
}
