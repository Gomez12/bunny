/**
 * Shared TOML serialisation helpers used by both the global (`[prompts]` in
 * `bunny.config.toml`) and per-project (`prompts.toml` under the project
 * directory) override writers.
 *
 * Bun ships `Bun.TOML.parse` but no serialiser; we only need to emit a
 * flat `[prompts]` table of strings, so a tiny hand-rolled encoder is
 * enough. The `multilineTomlString` helper also compensates for a Bun
 * parser quirk — see the comment on that function.
 */

/** Prompt override maps are always `{ key → text }`. */
export type PromptOverrides = Record<string, string>;

/** Dotted TOML keys like `kb.definition` must be bare-quoted. */
export function quoteKey(k: string): string {
  return /[.\s"]/.test(k) ? `"${k.replace(/"/g, '\\"')}"` : k;
}

/**
 * Emit a TOML string literal. Prefer a multi-line basic string (`"""…"""`)
 * whenever the value contains a newline; a single-line basic string is
 * used otherwise. Escapes are minimal and only cover backslashes and
 * runs of three double quotes.
 *
 * Bun's TOML parser does NOT trim the newline immediately following the
 * opening `"""` delimiter (contra the TOML spec), so the body starts on
 * the same line as the opening delimiter to preserve the round-trip.
 */
export function multilineTomlString(v: string): string {
  if (!v.includes("\n")) {
    return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  const escaped = v.replace(/\\/g, "\\\\").replace(/"""/g, '""\\"');
  return `"""${escaped}"""`;
}
