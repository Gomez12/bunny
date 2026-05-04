/**
 * Walk a code project directory and yield every source/doc file that should
 * be fed to the extractor. Honours the project-root `.gitignore` plus a fixed
 * set of always-skip directories, caps both file count and per-file size.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix } from "node:path";

export interface WalkOpts {
  rootAbs: string;
  maxFiles: number;
  maxFileSizeKb: number;
  /** Include doc files (md/pdf/docx) when true. Callers pass `docExtractionEnabled`. */
  includeDocs: boolean;
}

export interface WalkedFile {
  /** POSIX-style path relative to the code-project root (forward slashes). */
  relPath: string;
  absPath: string;
  /** File size in bytes. */
  size: number;
  /** Whether this is a doc file (md/pdf/docx) vs a source file. */
  isDoc: boolean;
}

const ALWAYS_IGNORE_DIRS: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  ".next",
  ".nuxt",
  "dist",
  "build",
  "target",
  "out",
  ".cache",
  ".turbo",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  "coverage",
]);

const SOURCE_EXTS: ReadonlySet<string> = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "mts",
  "cts",
  "py",
  "pyi",
  "go",
  "rs",
  "java",
  "c",
  "h",
  "cpp",
  "cc",
  "cxx",
  "hpp",
  "hh",
  "hxx",
  "rb",
  "php",
]);

const DOC_EXTS: ReadonlySet<string> = new Set([
  "md",
  "markdown",
  "pdf",
  "docx",
]);

/**
 * Minimal `.gitignore` matcher. Supports the common cases: comment lines,
 * blank lines, literal names, trailing `/` for directory-only, and leading
 * `!` for re-inclusion. Does NOT support nested `.gitignore` files or all
 * glob syntax — that's what `graphify` sacrifices for portability. In
 * practice the always-ignore set covers ~95% of noise.
 */
interface GitignoreRule {
  pattern: string;
  negate: boolean;
  dirOnly: boolean;
}

function parseGitignore(abs: string): GitignoreRule[] {
  let text: string;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    return [];
  }
  const rules: GitignoreRule[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    let negate = false;
    let pattern = line;
    if (pattern.startsWith("!")) {
      negate = true;
      pattern = pattern.slice(1);
    }
    const dirOnly = pattern.endsWith("/");
    if (dirOnly) pattern = pattern.slice(0, -1);
    // Leading `/` means "anchored to the root" — same meaning for our matcher.
    if (pattern.startsWith("/")) pattern = pattern.slice(1);
    if (pattern) rules.push({ pattern, negate, dirOnly });
  }
  return rules;
}

function matchesRule(
  rel: string,
  isDir: boolean,
  rule: GitignoreRule,
): boolean {
  if (rule.dirOnly && !isDir) return false;
  const name = rel.split("/").pop() ?? rel;
  // Exact match (name or full path) and simple suffix-glob (e.g. `*.log`).
  if (rule.pattern === rel || rule.pattern === name) return true;
  if (rule.pattern.startsWith("*.")) {
    const ext = rule.pattern.slice(1);
    if (rel.endsWith(ext) || name.endsWith(ext)) return true;
  }
  return false;
}

function isIgnored(
  rel: string,
  isDir: boolean,
  rules: GitignoreRule[],
): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (matchesRule(rel, isDir, rule)) {
      ignored = !rule.negate;
    }
  }
  return ignored;
}

export function walkCodeProject(opts: WalkOpts): WalkedFile[] {
  const rules = parseGitignore(join(opts.rootAbs, ".gitignore"));
  const out: WalkedFile[] = [];
  const stack: Array<{ abs: string; rel: string }> = [
    { abs: opts.rootAbs, rel: "" },
  ];
  const maxFileBytes = opts.maxFileSizeKb * 1024;

  while (stack.length > 0 && out.length < opts.maxFiles) {
    const { abs, rel } = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(abs);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (out.length >= opts.maxFiles) break;
      if (ALWAYS_IGNORE_DIRS.has(name)) continue;
      const full = join(abs, name);
      const entryRel = rel ? posix.join(rel, name) : name;
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (isIgnored(entryRel, true, rules)) continue;
        stack.push({ abs: full, rel: entryRel });
        continue;
      }
      if (!st.isFile()) continue;
      if (isIgnored(entryRel, false, rules)) continue;
      if (st.size > maxFileBytes) continue;
      const idx = name.lastIndexOf(".");
      if (idx < 0) continue;
      const ext = name.slice(idx + 1).toLowerCase();
      const isDoc = DOC_EXTS.has(ext);
      if (!isDoc && !SOURCE_EXTS.has(ext)) continue;
      if (isDoc && !opts.includeDocs) continue;
      out.push({
        relPath: entryRel,
        absPath: full,
        size: st.size,
        isDoc,
      });
    }
  }
  return out;
}
