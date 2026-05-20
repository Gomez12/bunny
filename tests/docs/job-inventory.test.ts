/**
 * Enforce that every `job.kind` registered against the scheduler
 * `HandlerRegistry` in `src/` is documented in
 * `docs/dev/architecture/job-inventory.md`, and vice versa.
 *
 * Strategy:
 *   1. Walk `src/`, regex-match every `registry.register(SOMETHING_HANDLER,…)`
 *      call, then resolve the literal string from the matching
 *      `export const SOMETHING_HANDLER = "…";` in the same file.
 *   2. Parse `docs/dev/architecture/job-inventory.md`, extract every backticked
 *      `job.kind` value from the first column of the agents table.
 *   3. Assert the two sets match. Failures list missing/extra entries on each
 *      side.
 *
 * Companion to `bun run docs:check` (see
 * `docs/dev/follow-ups/docs-check-script.md`). Keep this in lockstep with
 * `AGENTS.md` §"Pull Requests".
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const SRC_ROOT = join(REPO_ROOT, "src");
const INVENTORY_PATH = join(
  REPO_ROOT,
  "docs",
  "dev",
  "architecture",
  "job-inventory.md",
);

/**
 * Recursively yield every `.ts` file under `dir`. Skips obvious non-source
 * directories (`node_modules`, `dist`, etc.) just in case `src/` ever
 * contains a build artifact.
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

interface RegisterCall {
  /** The literal `job.kind` string value (e.g. `"board.auto_run_scan"`). */
  kind: string;
  /** Source file path relative to repo root (e.g. `src/board/auto_run_handler.ts`). */
  relPath: string;
  /** Constant identifier (e.g. `BOARD_AUTO_RUN_HANDLER`). */
  constantName: string;
}

/**
 * Collect every scheduler `registry.register(<CONST>, …)` call across `src/`.
 *
 * Only matches calls whose first argument is an `ALL_CAPS_HANDLER` constant
 * defined in the same file via `export const NAME = "…";`. This is the
 * pattern every domain module uses; the `src/tools/` registry uses string
 * literals as the first argument so it is naturally excluded.
 */
function collectRegisterCalls(): RegisterCall[] {
  // `registry.register(<CONST>, …)`. Captures the constant identifier.
  const callPattern = /\.register\(\s*([A-Z][A-Z0-9_]*_HANDLER)\b/g;
  // `export const <CONST> = "<value>";`. Captures the constant name + value.
  const constPattern =
    /export\s+const\s+([A-Z][A-Z0-9_]*_HANDLER)\s*=\s*"([^"]+)"/g;

  const out: RegisterCall[] = [];
  for (const abs of walkTs(SRC_ROOT)) {
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

    const relPath = abs.slice(REPO_ROOT.length + 1).replace(/\\/g, "/");
    for (const name of callMatches) {
      const value = consts.get(name);
      if (!value) {
        throw new Error(
          `Could not resolve ${name} in ${relPath}: ` +
            `the constant must be defined as 'export const ${name} = "…"' in the same file ` +
            `(or the regex used by this test needs updating).`,
        );
      }
      out.push({ kind: value, relPath, constantName: name });
    }
  }
  return out;
}

/**
 * Parse the rendered markdown inventory and return every `job.kind` declared
 * in the first column of any table row whose cells start with a backticked
 * value. Header / separator rows have no backticks and are skipped.
 */
function parseInventoryKinds(): string[] {
  const text = readFileSync(INVENTORY_PATH, "utf8");
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

describe("docs/dev/architecture/job-inventory.md", () => {
  test("matches the set of registered scheduler handlers in src/", () => {
    const calls = collectRegisterCalls();
    const registered = new Set(calls.map((c) => c.kind));
    const documented = new Set(parseInventoryKinds());

    const missingFromDoc = [...registered].filter((k) => !documented.has(k));
    const extraInDoc = [...documented].filter((k) => !registered.has(k));

    if (missingFromDoc.length > 0 || extraInDoc.length > 0) {
      const lines: string[] = [];
      if (missingFromDoc.length > 0) {
        lines.push(
          "Registered in src/ but missing from job-inventory.md:",
          ...missingFromDoc.sort().map((k) => `  - ${k}`),
        );
      }
      if (extraInDoc.length > 0) {
        lines.push(
          "Documented in job-inventory.md but not registered in src/:",
          ...extraInDoc.sort().map((k) => `  - ${k}`),
        );
      }
      throw new Error(
        ["job-inventory.md is out of sync with src/:", ...lines].join("\n"),
      );
    }

    expect(documented.size).toBeGreaterThan(0);
    expect(documented.size).toBe(registered.size);
  });

  test("each documented job.kind appears exactly once", () => {
    const documented = parseInventoryKinds();
    const seen = new Map<string, number>();
    for (const k of documented) {
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    const dupes = [...seen.entries()]
      .filter(([, n]) => n > 1)
      .map(([k, n]) => `${k} (×${n})`);
    expect(dupes).toEqual([]);
  });
});
