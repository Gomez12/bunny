#!/usr/bin/env bun
/**
 * `bun run i18n:check`
 *
 * Enforces the three i18n rules called out in `AGENTS.md` §i18n:
 *
 *   1. **No missing keys** — every static key referenced in
 *      `web/src/**` (via `t("…")`, `t('…')`, or `<Trans i18nKey="…">`)
 *      exists in *both* locale files.
 *   2. **No orphan keys** — every leaf key in either locale file is
 *      actually referenced in `web/src/**`.
 *   3. **Non-empty fallback** — every leaf value in `en.json` (the
 *      primary fallback per `AGENTS.md`) is a non-empty string.
 *
 * Dynamic-key calls (`t(variable)`, template literals, expressions) are
 * skipped, not failed — otherwise dynamic strings would be impossible to
 * ship. Document any dynamic key in the relevant follow-up.
 *
 * Exit code is 0 iff every rule passes. On failure each rule prints a
 * per-violation block; the summary line lists which rules failed.
 *
 * The implementation deliberately avoids regex-on-AST. The codebase is
 * small and the call patterns are constrained:
 *
 *   - `t("key")`  /  `t('key')`
 *   - `t("key", {...})`  /  `t('key', {...})`
 *   - `i18nKey="key"`  /  `i18nKey='key'`
 *
 * These three regexes catch the static cases; anything more dynamic is
 * intentionally ignored.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { findRepoRoot } from "./_lib/job_inventory.ts";

const REPO_ROOT = findRepoRoot(import.meta.dir);
const WEB_SRC = join(REPO_ROOT, "web", "src");
const LOCALES_DIR = join(WEB_SRC, "i18n", "locales");
const EN_PATH = join(LOCALES_DIR, "en.json");
const NL_PATH = join(LOCALES_DIR, "nl.json");

interface CheckResult {
  name: string;
  ok: boolean;
  summary: string;
  detail?: string;
}

/**
 * Walk every `.ts`/`.tsx` file under `web/src/`, except the i18n module
 * itself (its `import en from "./locales/en.json"` would otherwise trip
 * the locale-file parser, not the key extractor — defensive belt + braces).
 */
function* walkSourceFiles(root: string): Generator<string> {
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      // Skip generated / vendor dirs if any appear in future.
      if (entry === "node_modules" || entry === "dist") continue;
      yield* walkSourceFiles(full);
      continue;
    }
    if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) continue;
    // Skip the locale JSON files (handled separately) — JSON isn't walked
    // here because the extension filter excludes them, but keep the
    // explicit guard for clarity.
    if (entry.endsWith(".json")) continue;
    yield full;
  }
}

/**
 * Strip `//` line comments and `/* … *\/` block comments from a source
 * file before scanning. Keeps the JSDoc example `t("nav.items.<id>")`
 * out of the extracted-key set.
 *
 * String literals do not contain unescaped line breaks in practice and
 * comments do not nest, so a simple lexer suffices.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/**
 * Valid characters inside a translation key. Dotted dot-paths of
 * `[a-zA-Z0-9_.-]+` cover every key shape AGENTS.md showcases and
 * keeps real strings (with spaces, punctuation, `<`/`>`) from being
 * mistaken for keys.
 */
const KEY_CHARS = "[A-Za-z0-9_.-]+";

/**
 * Extract every static i18n key referenced in a source file.
 *
 * Patterns matched:
 *   t("key")            t('key')
 *   t("key", { … })     t('key', { … })
 *   i18nKey="key"       i18nKey='key'
 */
function extractKeysFromSource(text: string): string[] {
  const stripped = stripComments(text);
  const keys: string[] = [];
  const patterns = [
    new RegExp(`\\bt\\(\\s*"(${KEY_CHARS})"\\s*[,)]`, "g"),
    new RegExp(`\\bt\\(\\s*'(${KEY_CHARS})'\\s*[,)]`, "g"),
    new RegExp(`\\bi18nKey\\s*=\\s*"(${KEY_CHARS})"`, "g"),
    new RegExp(`\\bi18nKey\\s*=\\s*'(${KEY_CHARS})'`, "g"),
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(stripped)) !== null) {
      keys.push(m[1]!);
    }
  }
  return keys;
}

/**
 * Flatten a nested locale object to its dot-path leaves. Throws on
 * non-string leaves so a typo (`"ok": 42`) fails the check loudly.
 */
function flatten(obj: unknown, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error(
      `Locale object at "${prefix || "<root>"}" must be a plain object`,
    );
  }
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const [k, v] of flatten(value, path)) out.set(k, v);
      continue;
    }
    if (typeof value !== "string") {
      throw new Error(
        `Locale value at "${path}" must be a string; got ${typeof value}`,
      );
    }
    out.set(path, value);
  }
  return out;
}

function loadLocale(path: string): Map<string, string> {
  const raw = readFileSync(path, "utf8");
  return flatten(JSON.parse(raw));
}

function collectUsedKeys(): Set<string> {
  const used = new Set<string>();
  for (const file of walkSourceFiles(WEB_SRC)) {
    const text = readFileSync(file, "utf8");
    for (const k of extractKeysFromSource(text)) used.add(k);
  }
  return used;
}

function checkMissingKeys(
  used: Set<string>,
  en: Map<string, string>,
  nl: Map<string, string>,
): CheckResult {
  const missingEn: string[] = [];
  const missingNl: string[] = [];
  for (const k of used) {
    if (!en.has(k)) missingEn.push(k);
    if (!nl.has(k)) missingNl.push(k);
  }
  const total = missingEn.length + missingNl.length;
  if (total > 0) {
    const lines: string[] = [];
    if (missingEn.length > 0) {
      lines.push(
        "Used in code but missing from en.json:",
        ...missingEn.sort().map((k) => `  - ${k}`),
      );
    }
    if (missingNl.length > 0) {
      lines.push(
        "Used in code but missing from nl.json:",
        ...missingNl.sort().map((k) => `  - ${k}`),
      );
    }
    return {
      name: "no-missing-keys",
      ok: false,
      summary: `${total} missing key${total === 1 ? "" : "s"}`,
      detail: lines.join("\n"),
    };
  }
  return {
    name: "no-missing-keys",
    ok: true,
    summary: `${used.size} key${used.size === 1 ? "" : "s"} resolved in en+nl`,
  };
}

function checkOrphanKeys(
  used: Set<string>,
  en: Map<string, string>,
  nl: Map<string, string>,
): CheckResult {
  const orphans = new Set<string>();
  for (const k of en.keys()) if (!used.has(k)) orphans.add(k);
  for (const k of nl.keys()) if (!used.has(k)) orphans.add(k);
  if (orphans.size > 0) {
    return {
      name: "no-orphan-keys",
      ok: false,
      summary: `${orphans.size} orphan key${orphans.size === 1 ? "" : "s"}`,
      detail:
        "Keys present in a locale file but never referenced in web/src/**:\n" +
        [...orphans]
          .sort()
          .map((k) => `  - ${k}`)
          .join("\n"),
    };
  }
  return {
    name: "no-orphan-keys",
    ok: true,
    summary: "no orphan keys",
  };
}

function checkFallbackNonEmpty(en: Map<string, string>): CheckResult {
  const empty: string[] = [];
  for (const [k, v] of en) if (v.trim() === "") empty.push(k);
  if (empty.length > 0) {
    return {
      name: "fallback-non-empty",
      ok: false,
      summary: `${empty.length} empty fallback value${empty.length === 1 ? "" : "s"}`,
      detail:
        "Empty string in en.json (primary fallback per AGENTS.md §i18n):\n" +
        empty
          .sort()
          .map((k) => `  - ${k}`)
          .join("\n"),
    };
  }
  return {
    name: "fallback-non-empty",
    ok: true,
    summary: `${en.size} fallback value${en.size === 1 ? "" : "s"} non-empty`,
  };
}

function main(): number {
  const en = loadLocale(EN_PATH);
  const nl = loadLocale(NL_PATH);
  const used = collectUsedKeys();

  const checks: CheckResult[] = [
    checkMissingKeys(used, en, nl),
    checkOrphanKeys(used, en, nl),
    checkFallbackNonEmpty(en),
  ];

  for (const c of checks) {
    const mark = c.ok ? "OK " : "FAIL";
    // eslint-disable-next-line no-console
    console.log(`[${mark}] ${c.name} — ${c.summary}`);
    if (!c.ok && c.detail) {
      // eslint-disable-next-line no-console
      console.log(c.detail);
    }
  }

  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `\ni18n:check failed (${failed.length}/${checks.length}): ${failed
        .map((c) => c.name)
        .join(", ")}`,
    );
    return 1;
  }
  // eslint-disable-next-line no-console
  console.log(`\ni18n:check passed (${checks.length}/${checks.length}).`);
  return 0;
}

process.exit(main());
