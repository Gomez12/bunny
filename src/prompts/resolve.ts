/**
 * Prompt resolver.
 *
 * Three-tier fallback (highest wins):
 *   1. Per-project override (`$BUNNY_HOME/projects/<name>/prompts.toml`)
 *   2. Global override      (`[prompts]` block in `bunny.config.toml`)
 *   3. Registry default     (the hardcoded string baked into `registry.ts`)
 *
 * Both override sources are mtime-cached: edits take effect on the next LLM
 * turn without a server restart, without re-parsing the whole config.
 *
 * `resolvePrompt` returns raw template text. Callers that use variables must
 * pass the result through {@link interpolate} — resolver never substitutes,
 * so call sites stay in control of escaping and conditional composition.
 */

import { PROMPTS } from "./registry.ts";
import { loadGlobalPromptOverrides } from "./global_overrides.ts";
import { loadProjectPromptOverrides } from "../memory/prompt_overrides.ts";

export interface ResolveOpts {
  /** Project name — when set, per-project overrides take precedence. */
  project?: string | undefined;
}

/** Resolve a prompt key to its effective text. Unknown keys throw. */
export function resolvePrompt(key: string, opts: ResolveOpts = {}): string {
  const def = PROMPTS[key];
  if (!def) throw new Error(`unknown prompt key: ${key}`);
  if (opts.project) {
    try {
      const overrides = loadProjectPromptOverrides(opts.project);
      const hit = overrides[key];
      if (typeof hit === "string") return hit;
    } catch {
      // Malformed prompts.toml → fall through to global/default. Never fatal.
    }
  }
  const globals = loadGlobalPromptOverrides();
  const hit = globals[key];
  if (typeof hit === "string") return hit;
  return def.defaultText;
}

/**
 * Substitute `{{name}}` placeholders. Unknown placeholders throw so typos are
 * loud rather than silent. Values are stringified via `String(...)`. The
 * template can embed literal braces as `{{{}}}` (a `{{{` prefix) — escape
 * there is *not* supported on purpose: prompts are operator-trusted content,
 * and a real brace in model output is rare.
 */
export function interpolate(
  template: string,
  vars: Record<string, unknown> = {},
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
    if (!(name in vars)) {
      throw new Error(`interpolate: missing variable "${name}"`);
    }
    return String(vars[name]);
  });
}

/** Convenience: resolve then interpolate in a single call. */
export function renderPrompt(
  key: string,
  vars: Record<string, unknown> = {},
  opts: ResolveOpts = {},
): string {
  return interpolate(resolvePrompt(key, opts), vars);
}
