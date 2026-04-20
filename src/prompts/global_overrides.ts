/**
 * Global prompt overrides — `[prompts]` block in `bunny.config.toml`.
 *
 * Read directly here (not via `loadConfig`) because `loadConfig` runs once at
 * startup; an admin-edited prompt needs to take effect on the next LLM call
 * without a server restart. The loader is mtime-cached: on a config file with
 * no `[prompts]` block (the zero-override boot state) this returns `{}`.
 *
 * Write-path lives alongside the reader so admin PUT handlers can mutate the
 * file without duplicating TOML serialisation logic.
 */

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { paths } from "../paths.ts";
import {
  multilineTomlString,
  quoteKey,
  type PromptOverrides,
} from "./toml_utils.ts";

export type GlobalPromptOverrides = PromptOverrides;

interface CacheEntry {
  mtimeMs: number;
  overrides: GlobalPromptOverrides;
}

const cache = new Map<string, CacheEntry>();

/** Resolve the config path once per call, honouring cwd overrides in tests. */
function configPath(cwd?: string): string {
  return paths.configFile(cwd ?? process.cwd());
}

/**
 * Load `[prompts]` from `bunny.config.toml`. Returns an empty object when:
 *   - the file doesn't exist, or
 *   - the `[prompts]` block is missing, or
 *   - the file is malformed.
 *
 * Non-string values are silently dropped so a well-meaning TOML typo (e.g.
 * `= 42`) doesn't poison the registry. Cached by mtime.
 */
export function loadGlobalPromptOverrides(cwd?: string): GlobalPromptOverrides {
  const file = configPath(cwd);
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
    const parsed = Bun.TOML.parse(text) as {
      prompts?: Record<string, unknown>;
    };
    const raw = parsed.prompts ?? {};
    const overrides: GlobalPromptOverrides = {};
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
 * Write one override. Passing `text: null` deletes the key (falls back to the
 * registry default). Preserves every other block in `bunny.config.toml` by
 * stripping only the existing `[prompts]` section and appending a fresh one;
 * no full round-trip through a TOML serialiser (Bun has none).
 */
export function setGlobalPromptOverride(
  key: string,
  text: string | null,
  cwd?: string,
): void {
  const file = configPath(cwd);
  let existing = "";
  try {
    existing = readFileSync(file, "utf8");
  } catch {
    existing = "";
  }
  const parsed = existing
    ? ((Bun.TOML.parse(existing) as Record<string, unknown>) ?? {})
    : {};
  const prompts = { ...((parsed["prompts"] as Record<string, unknown> | undefined) ?? {}) };
  if (text === null) {
    delete prompts[key];
  } else {
    prompts[key] = text;
  }
  const nextToml = serialiseWithPrompts(existing, prompts);
  writeFileSync(file, nextToml, "utf8");
  // Eagerly invalidate — the mtime check will pick up the write on the next
  // read, but tests can run faster than mtime resolution on some filesystems.
  cache.delete(file);
}

function serialiseWithPrompts(
  original: string,
  prompts: Record<string, unknown>,
): string {
  const stripped = stripPromptsSection(original);
  const header = stripped.length && !stripped.endsWith("\n") ? "\n" : "";
  const keys = Object.keys(prompts).sort();
  if (keys.length === 0) return stripped + header;
  const lines: string[] = ["[prompts]"];
  for (const k of keys) {
    const v = prompts[k];
    if (typeof v !== "string") continue;
    lines.push(`${quoteKey(k)} = ${multilineTomlString(v)}`);
  }
  return `${stripped}${header}${lines.join("\n")}\n`;
}

/** Remove an existing `[prompts]` table (and its key/value lines) from the TOML. */
function stripPromptsSection(text: string): string {
  if (!text) return text;
  const lines = text.split("\n");
  const out: string[] = [];
  let inPrompts = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      inPrompts = trimmed === "[prompts]";
      if (!inPrompts) out.push(line);
      continue;
    }
    if (!inPrompts) out.push(line);
  }
  while (out.length && out[out.length - 1]?.trim() === "") out.pop();
  return out.join("\n");
}

/** Test helper — drop the mtime cache so tests can assert file-based reloads. */
export function __clearGlobalPromptsCache(): void {
  cache.clear();
}
