/**
 * Enforce that every `job.kind` registered against the scheduler
 * `HandlerRegistry` in `src/` is documented in
 * `docs/dev/architecture/job-inventory.md`, and vice versa.
 *
 * The actual parsing and diff live in
 * [`scripts/_lib/job_inventory.ts`](../../scripts/_lib/job_inventory.ts) so
 * `bun run docs:check` and this test share one implementation. Keep them in
 * lockstep with `AGENTS.md` §"Pull Requests".
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  collectRegisterCalls,
  diffInventory,
  findRepoRoot,
  parseInventoryKinds,
} from "../../scripts/_lib/job_inventory.ts";

const REPO_ROOT = findRepoRoot(import.meta.dir);
const SRC_ROOT = join(REPO_ROOT, "src");
const INVENTORY_PATH = join(
  REPO_ROOT,
  "docs",
  "dev",
  "architecture",
  "job-inventory.md",
);

describe("docs/dev/architecture/job-inventory.md", () => {
  test("matches the set of registered scheduler handlers in src/", () => {
    const calls = collectRegisterCalls(REPO_ROOT, SRC_ROOT);
    const registered = new Set(calls.map((c) => c.kind));
    const documented = new Set(parseInventoryKinds(INVENTORY_PATH));

    const { missingFromDoc, extraInDoc } = diffInventory(
      registered,
      documented,
    );

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
      throw new Error(
        ["job-inventory.md is out of sync with src/:", ...lines].join("\n"),
      );
    }

    expect(documented.size).toBeGreaterThan(0);
    expect(documented.size).toBe(registered.size);
  });

  test("each documented job.kind appears exactly once", () => {
    const documented = parseInventoryKinds(INVENTORY_PATH);
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
