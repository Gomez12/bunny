#!/usr/bin/env bun
/**
 * `bun run docs:check`
 *
 * Enforces the three doc-discipline rules from `AGENTS.md` §"Pull Requests":
 *
 *   1. Every `*.md` under `docs/dev/plans/` (except the directory index
 *      `README.md`) is referenced from `docs/dev/tasklist.md`.
 *   2. `docs/dev/tasklist.md` keeps at most 50 rows whose status column is
 *      exactly `done`.
 *   3. Every `job.kind` registered via `registry.register(KIND_HANDLER, …)`
 *      in `src/` appears in the table in
 *      `docs/dev/architecture/job-inventory.md`, and vice versa.
 *
 * Runs all three checks, prints a per-check summary, and exits with code 0
 * iff every check passes. The script resolves the repo root from a sentinel
 * (`package.json`) and never relies on the caller's `cwd`.
 *
 * The job-inventory diff shares its implementation with
 * `tests/docs/job-inventory.test.ts` via
 * [`./_lib/job_inventory.ts`](./_lib/job_inventory.ts) — keep both in
 * lockstep with `AGENTS.md`.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  collectRegisterCalls,
  diffInventory,
  findRepoRoot,
  parseInventoryKinds,
} from "./_lib/job_inventory.ts";

const REPO_ROOT = findRepoRoot(import.meta.dir);
const TASKLIST_PATH = join(REPO_ROOT, "docs", "dev", "tasklist.md");
const PLANS_DIR = join(REPO_ROOT, "docs", "dev", "plans");
const INVENTORY_PATH = join(
  REPO_ROOT,
  "docs",
  "dev",
  "architecture",
  "job-inventory.md",
);
const SRC_ROOT = join(REPO_ROOT, "src");

const MAX_DONE_ROWS = 50;

interface CheckResult {
  name: string;
  ok: boolean;
  /** One-line summary printed on success (e.g. `12 plans referenced`). */
  summary: string;
  /** Multi-line failure detail printed when `ok === false`. */
  detail?: string;
}

/**
 * Check 1: every plan file is referenced from `tasklist.md`.
 *
 * "Plan file" = any `*.md` directly under `docs/dev/plans/` except
 * `README.md` (the directory index, not a plan). Reference detection is a
 * simple substring match against the path fragment
 * `docs/dev/plans/<filename>` — that is the canonical form already used by
 * existing tasklist rows.
 */
function checkPlansReferenced(): CheckResult {
  const planFiles = readdirSync(PLANS_DIR)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .sort();

  const tasklist = readFileSync(TASKLIST_PATH, "utf8");
  const missing: string[] = [];
  for (const f of planFiles) {
    const needle = `docs/dev/plans/${f}`;
    if (!tasklist.includes(needle)) missing.push(needle);
  }

  if (missing.length > 0) {
    return {
      name: "plans-referenced",
      ok: false,
      summary: `${planFiles.length - missing.length} of ${planFiles.length} plans referenced`,
      detail:
        "Plan files not referenced from docs/dev/tasklist.md:\n" +
        missing.map((p) => `  - ${p}`).join("\n"),
    };
  }
  return {
    name: "plans-referenced",
    ok: true,
    summary: `${planFiles.length} plan${planFiles.length === 1 ? "" : "s"} referenced`,
  };
}

/**
 * Check 2: at most `MAX_DONE_ROWS` rows in `tasklist.md` have status `done`.
 *
 * The first column of every task row is the status. Match by cell value
 * (trim then equality) instead of regex on the raw line — this avoids
 * accidental matches against future statuses that happen to contain the
 * substring "done".
 */
function checkDoneRows(): CheckResult {
  const text = readFileSync(TASKLIST_PATH, "utf8");
  let doneCount = 0;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const cells = trimmed
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());
    if (cells.length < 4) continue;
    if (cells[0] === "done") doneCount++;
  }

  if (doneCount > MAX_DONE_ROWS) {
    return {
      name: "max-50-done",
      ok: false,
      summary: `${doneCount} done rows`,
      detail:
        `docs/dev/tasklist.md has ${doneCount} done rows (max ${MAX_DONE_ROWS}). ` +
        `Move the oldest done tasks to docs/dev/tasklistarchive.md.`,
    };
  }
  return {
    name: "max-50-done",
    ok: true,
    summary: `${doneCount} done row${doneCount === 1 ? "" : "s"} (limit ${MAX_DONE_ROWS})`,
  };
}

/**
 * Check 3: registered `job.kind` set in `src/` equals the documented set in
 * `docs/dev/architecture/job-inventory.md`. Delegates to the shared lib.
 */
function checkJobInventory(): CheckResult {
  const calls = collectRegisterCalls(REPO_ROOT, SRC_ROOT);
  const registered = new Set(calls.map((c) => c.kind));
  const documented = new Set(parseInventoryKinds(INVENTORY_PATH));
  const { missingFromDoc, extraInDoc } = diffInventory(registered, documented);

  if (missingFromDoc.length > 0 || extraInDoc.length > 0) {
    const lines: string[] = [];
    if (missingFromDoc.length > 0) {
      lines.push(
        "Registered in src/ but missing from job-inventory.md:",
        ...missingFromDoc.map((k) => `  - ${k}`),
      );
    }
    if (extraInDoc.length > 0) {
      lines.push(
        "Documented in job-inventory.md but not registered in src/:",
        ...extraInDoc.map((k) => `  - ${k}`),
      );
    }
    return {
      name: "job-inventory",
      ok: false,
      summary: `${registered.size} registered vs ${documented.size} documented`,
      detail: lines.join("\n"),
    };
  }
  return {
    name: "job-inventory",
    ok: true,
    summary: `${registered.size} job kind${registered.size === 1 ? "" : "s"} in sync`,
  };
}

function main(): number {
  const checks: CheckResult[] = [
    checkPlansReferenced(),
    checkDoneRows(),
    checkJobInventory(),
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
      `\ndocs:check failed (${failed.length}/${checks.length}): ${failed
        .map((c) => c.name)
        .join(", ")}`,
    );
    return 1;
  }
  // eslint-disable-next-line no-console
  console.log(`\ndocs:check passed (${checks.length}/${checks.length}).`);
  return 0;
}

process.exit(main());
