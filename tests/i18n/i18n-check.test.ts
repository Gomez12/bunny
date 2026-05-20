/**
 * Smoke test for `bun run i18n:check`.
 *
 * Spawns the script in a subprocess so the assertion mirrors what CI sees
 * via `bun run check`. A green run means:
 *
 *   - Every `t("…")` / `<Trans i18nKey="…">` reference under `web/src/`
 *     resolves in both locale files.
 *   - No orphan keys.
 *   - Every English fallback string is non-empty.
 *
 * The actual rule logic lives in
 * [`scripts/i18n-check.ts`](../../scripts/i18n-check.ts); see
 * `docs/dev/plans/i18n-introduction.md` for the full convention.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { findRepoRoot } from "../../scripts/_lib/job_inventory.ts";

const REPO_ROOT = findRepoRoot(import.meta.dir);
const SCRIPT_PATH = join(REPO_ROOT, "scripts", "i18n-check.ts");

describe("bun run i18n:check", () => {
  test("exits 0 against the current locale + code state", async () => {
    const proc = Bun.spawn(["bun", "run", SCRIPT_PATH], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    if (exitCode !== 0) {
      // Surface the script output so a failing check is debuggable from
      // the test report without re-running the script by hand.
      // eslint-disable-next-line no-console
      console.error(`i18n-check stdout:\n${stdout}`);
      // eslint-disable-next-line no-console
      console.error(`i18n-check stderr:\n${stderr}`);
    }

    expect(exitCode).toBe(0);
    expect(stdout).toContain("i18n:check passed");
  });
});
