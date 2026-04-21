/**
 * End-to-end `executeBash` tests — exercises `Bun.spawn` against real
 * shells, covering timeout, output cap, env whitelist, and cwd safety.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeBash, executeScript } from "../../src/workflows/bash_exec.ts";
import { ensureProjectDir } from "../../src/memory/project_assets.ts";
import type { WorkflowsConfig } from "../../src/config.ts";

let originalCwd: string;
let tmp: string;

beforeAll(() => {
  originalCwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), "bunny-bash-"));
  process.chdir(tmp);
  ensureProjectDir("bash-test");
});

afterAll(() => {
  process.chdir(originalCwd);
  rmSync(tmp, { recursive: true, force: true });
});

const CFG: WorkflowsConfig = {
  bashEnabled: true,
  bashDefaultTimeoutMs: 120_000,
  bashMaxOutputBytes: 256 * 1024,
  scriptEnabled: false,
  scriptDefaultTimeoutMs: 120_000,
  scriptMaxOutputBytes: 256 * 1024,
  loopDefaultMaxIterations: 10,
};

describe("executeBash", () => {
  test("captures stdout and returns tail", async () => {
    const res = await executeBash({
      project: "bash-test",
      command: "echo hello && echo world",
      cfg: CFG,
    });
    expect(res.exitCode).toBe(0);
    expect(res.output).toContain("hello");
    expect(res.output).toContain("world");
    expect(res.tail).toContain("world");
    expect(res.truncated).toBe(false);
    expect(res.timedOut).toBe(false);
  });

  test("truncates output past the cap", async () => {
    const res = await executeBash({
      project: "bash-test",
      command: "yes 'a' | head -c 50000",
      cfg: { ...CFG, bashMaxOutputBytes: 1024 },
    });
    expect(res.exitCode).toBe(0);
    expect(res.truncated).toBe(true);
    expect(res.output.length).toBeLessThan(2000);
  });

  test("honours timeout and reports timedOut", async () => {
    const res = await executeBash({
      project: "bash-test",
      command: "sleep 3",
      cfg: CFG,
      timeoutMs: 200,
    });
    expect(res.timedOut).toBe(true);
    expect(res.durationMs).toBeGreaterThan(150);
  });

  test("strips secret env vars", async () => {
    // Pollute the env with a fake secret; the child must not see it.
    process.env["LLM_API_KEY"] = "super-secret";
    try {
      const res = await executeBash({
        project: "bash-test",
        command: "printenv LLM_API_KEY || echo MISSING",
        cfg: CFG,
      });
      expect(res.output).toContain("MISSING");
      expect(res.output).not.toContain("super-secret");
    } finally {
      delete process.env["LLM_API_KEY"];
    }
  });

  test("BUNNY_PROJECT is exported to the child", async () => {
    const res = await executeBash({
      project: "bash-test",
      command: "printenv BUNNY_PROJECT",
      cfg: CFG,
    });
    expect(res.output.trim()).toContain("bash-test");
  });

  test("runs in the workspace cwd", async () => {
    const res = await executeBash({
      project: "bash-test",
      command: "pwd",
      cfg: CFG,
    });
    expect(res.output).toContain("bash-test");
    expect(res.output).toContain("workspace");
  });
});

describe("executeScript", () => {
  test("runs a TypeScript snippet via bun -e", async () => {
    const res = await executeScript({
      project: "bash-test",
      code: "const xs = [1,2,3]; console.log(xs.reduce((a,b)=>a+b, 0));",
      cfg: { ...CFG, scriptEnabled: true },
    });
    expect(res.exitCode).toBe(0);
    expect(res.output.trim()).toBe("6");
  });

  test("surfaces a thrown error as non-zero exit", async () => {
    const res = await executeScript({
      project: "bash-test",
      code: "throw new Error('boom');",
      cfg: { ...CFG, scriptEnabled: true },
    });
    expect(res.exitCode).not.toBe(0);
    expect(res.output).toContain("boom");
  });

  test("honours the script timeout", async () => {
    const res = await executeScript({
      project: "bash-test",
      code: "await Bun.sleep(3000); console.log('late');",
      cfg: { ...CFG, scriptEnabled: true },
      timeoutMs: 200,
    });
    expect(res.timedOut).toBe(true);
  });
});
