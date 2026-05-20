/**
 * Shared helpers for the `job.kind` inventory diff.
 *
 * Both `bun run docs:check` (see `scripts/docs-check.ts`) and the
 * `tests/docs/job-inventory.test.ts` companion test rely on these two
 * functions to compute the same two sets:
 *
 *   1. `collectRegisterCalls(srcRoot)` — walks every `.ts` file under
 *      `srcRoot`, regex-matches every `registry.register(SOMETHING_HANDLER, …)`
 *      call, and resolves the literal string from the matching
 *      `export const SOMETHING_HANDLER = "…";` in the same file.
 *
 *   2. `parseInventoryKinds(inventoryPath)` — parses the rendered
 *      `docs/dev/architecture/job-inventory.md` table and returns every
 *      backticked first-column value.
 *
 * The helpers take their root / file paths as arguments so callers compute
 * their own repo root (e.g. via `findRepoRoot()` below) instead of baking a
 * test- or script-relative offset into the shared module.
 */

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface RegisterCall {
  /** The literal `job.kind` string value (e.g. `"board.auto_run_scan"`). */
  kind: string;
  /** Source file path relative to repo root (e.g. `src/board/auto_run_handler.ts`). */
  relPath: string;
  /** Constant identifier (e.g. `BOARD_AUTO_RUN_HANDLER`). */
  constantName: string;
}

/**
 * Resolve the repository root by walking up from `startDir` until a
 * `package.json` is found. Throws if none exists between `startDir` and the
 * filesystem root.
 *
 * Using a sentinel (rather than a hard-coded relative offset) keeps callers
 * portable: the script, the test, and any future caller can all sit at
 * arbitrary depths.
 */
export function findRepoRoot(startDir: string): string {
  let cur = resolve(startDir);
  // Stop when `parent === cur` (filesystem root).
  for (;;) {
    if (existsSync(join(cur, "package.json"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) {
      throw new Error(
        `findRepoRoot: no package.json found at or above ${startDir}`,
      );
    }
    cur = parent;
  }
}

/**
 * Recursively yield every `.ts` file under `dir`. Skips obvious non-source
 * directories (`node_modules`, `dist`, dotfiles) just in case the tree
 * contains build artifacts.
 */
function* walkTs(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) {
      continue;
    }
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      yield* walkTs(full);
    } else if (st.isFile() && entry.endsWith(".ts")) {
      yield full;
    }
  }
}

/**
 * Collect every scheduler `registry.register(<CONST>, …)` call across the
 * given source root.
 *
 * Only matches calls whose first argument is an `ALL_CAPS_HANDLER` constant
 * defined in the same file via `export const NAME = "…";`. This is the
 * pattern every domain module uses; the `src/tools/` registry uses string
 * literals as the first argument so it is naturally excluded.
 *
 * `repoRoot` is only used to compute relative paths in error messages /
 * results. `srcRoot` is the directory actually walked.
 */
export function collectRegisterCalls(
  repoRoot: string,
  srcRoot: string,
): RegisterCall[] {
  // `registry.register(<CONST>, …)`. Captures the constant identifier.
  const callPattern = /\.register\(\s*([A-Z][A-Z0-9_]*_HANDLER)\b/g;
  // `export const <CONST> = "<value>";`. Captures the constant name + value.
  const constPattern =
    /export\s+const\s+([A-Z][A-Z0-9_]*_HANDLER)\s*=\s*"([^"]+)"/g;

  const out: RegisterCall[] = [];
  for (const abs of walkTs(srcRoot)) {
    const text = readFileSync(abs, "utf8");
    const callMatches: string[] = [];
    for (const m of text.matchAll(callPattern)) {
      callMatches.push(m[1]!);
    }
    if (callMatches.length === 0) continue;

    const consts = new Map<string, string>();
    for (const m of text.matchAll(constPattern)) {
      consts.set(m[1]!, m[2]!);
    }

    const relPath = abs.slice(repoRoot.length + 1).replace(/\\/g, "/");
    for (const name of callMatches) {
      const value = consts.get(name);
      if (!value) {
        throw new Error(
          `Could not resolve ${name} in ${relPath}: ` +
            `the constant must be defined as 'export const ${name} = "…"' in the same file ` +
            `(or the regex used by this helper needs updating).`,
        );
      }
      out.push({ kind: value, relPath, constantName: name });
    }
  }
  return out;
}

/**
 * Parse the rendered markdown inventory at `inventoryPath` and return every
 * `job.kind` declared in the first column of any table row whose cell starts
 * with a backticked value. The literal table header (`` `job.kind` ``) is
 * skipped; separator rows have no backticks and are skipped naturally.
 */
export function parseInventoryKinds(inventoryPath: string): string[] {
  const text = readFileSync(inventoryPath, "utf8");
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const cells = trimmed
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());
    if (cells.length < 1) continue;
    const first = cells[0]!;
    const inline = first.match(/^`([^`]+)`$/);
    if (!inline) continue;
    const value = inline[1]!;
    // Skip the table header (`` `job.kind` ``); only real registrations
    // contain a dot in their kind ("domain.action_scan").
    if (value === "job.kind") continue;
    out.push(value);
  }
  return out;
}

/**
 * Compute the symmetric difference between the registered set and the
 * documented set. Both lists are returned sorted for stable output.
 */
export function diffInventory(
  registered: Iterable<string>,
  documented: Iterable<string>,
): { missingFromDoc: string[]; extraInDoc: string[] } {
  const reg = new Set(registered);
  const doc = new Set(documented);
  const missingFromDoc = [...reg].filter((k) => !doc.has(k)).sort();
  const extraInDoc = [...doc].filter((k) => !reg.has(k)).sort();
  return { missingFromDoc, extraInDoc };
}
