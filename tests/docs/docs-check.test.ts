/**
 * Smoke test for `bun run docs:check`.
 *
 * Spawns the script via `Bun.spawn` against the live repo state and asserts
 * exit code 0. The repo must be in a clean state (all three checks
 * passing) for this test to be green — that is the same invariant
 * `bun run docs:check` itself enforces, so a failure here means either the
 * script regressed or the repo drifted out of policy.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { findRepoRoot } from "../../scripts/_lib/job_inventory.ts";

const REPO_ROOT = findRepoRoot(import.meta.dir);
const SCRIPT = join(REPO_ROOT, "scripts", "docs-check.ts");

describe("scripts/docs-check.ts", () => {
  test("exits 0 against the current repo", async () => {
    const proc = Bun.spawn(["bun", "run", SCRIPT], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (code !== 0) {
      // Surface the script's own per-check output to make CI failures
      // diagnose themselves without rerunning.
      throw new Error(
        `docs:check exited ${code}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
      );
    }
    expect(code).toBe(0);
    // Sanity: the script prints one OK line per check (3 total).
    expect(stdout).toContain("plans-referenced");
    expect(stdout).toContain("max-50-done");
    expect(stdout).toContain("job-inventory");
  });
});
