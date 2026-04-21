/**
 * Gated bash executor for workflow `bash` nodes.
 *
 * Not a tool — called directly by `run_workflow.ts`. Security gates:
 *  1. Global flag `[workflows] bash_enabled` (default false). Route layer
 *     rejects runs of workflows containing bash nodes when this is off.
 *  2. Per-node first-run approval — a sha256 of the command is recorded on
 *     `workflows.bash_approvals`; edits to the command re-prompt. Approval
 *     itself happens via the engine (see `run_workflow.ts`) — this module
 *     just executes.
 *  3. Working directory = `<projectDir>/workspace/`. Not a sandbox; a trust
 *     gate.
 *  4. Timeout + output cap: default 120 s, hard max 600 s; stdout+stderr
 *     capped at `bashMaxOutputBytes` (default 256 KiB) with `...truncated`.
 *
 * Env stripped to an explicit whitelist — API keys and admin passwords never
 * leak to spawned processes.
 */

import { createHash } from "node:crypto";
import { safeWorkspacePath } from "../memory/workspace_fs.ts";
import type { WorkflowsConfig } from "../config.ts";

export interface BashExecOpts {
  project: string;
  command: string;
  timeoutMs?: number;
  cfg: WorkflowsConfig;
  /** Called repeatedly with chunks of combined stdout/stderr (decoded). */
  onChunk?: (chunk: string) => void;
}

export interface BashExecResult {
  exitCode: number;
  /** Last ~4 KiB of combined stdout/stderr for `result_text`. */
  tail: string;
  /** Full combined stdout/stderr, truncated at `bashMaxOutputBytes`. */
  output: string;
  truncated: boolean;
  durationMs: number;
  /** True when the command was killed for exceeding `timeoutMs`. */
  timedOut: boolean;
}

const HARD_MAX_TIMEOUT_MS = 600_000;
const MIN_TIMEOUT_MS = 100;
const ENV_ALLOWLIST = ["PATH", "HOME", "LANG", "LC_ALL", "BUNNY_HOME"] as const;

export function hashCommand(command: string): string {
  return createHash("sha256").update(command, "utf8").digest("hex");
}

function filterEnv(project: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ENV_ALLOWLIST) {
    const v = process.env[k];
    if (typeof v === "string") out[k] = v;
  }
  out["BUNNY_PROJECT"] = project;
  return out;
}

export async function executeBash(opts: BashExecOpts): Promise<BashExecResult> {
  return runChildProcess(
    ["sh", "-c", opts.command],
    opts.project,
    opts.timeoutMs ?? opts.cfg.bashDefaultTimeoutMs,
    opts.cfg.bashMaxOutputBytes,
    opts.onChunk,
  );
}

/**
 * Run a JS / TS / Bun code snippet via `bun -e`. Same security envelope
 * as bash: runs in a child process with the same stripped environment,
 * same workspace cwd, same timeout + output cap. The caller is
 * responsible for checking `cfg.scriptEnabled` and managing first-run
 * approval (see `dispatchScript` in run_workflow.ts).
 */
export async function executeScript(opts: {
  project: string;
  code: string;
  timeoutMs?: number;
  cfg: WorkflowsConfig;
  onChunk?: (chunk: string) => void;
}): Promise<BashExecResult> {
  return runChildProcess(
    ["bun", "-e", opts.code],
    opts.project,
    opts.timeoutMs ?? opts.cfg.scriptDefaultTimeoutMs,
    opts.cfg.scriptMaxOutputBytes,
    opts.onChunk,
  );
}

async function runChildProcess(
  cmd: string[],
  project: string,
  rawTimeout: number,
  rawMaxOutput: number,
  onChunk?: (chunk: string) => void,
): Promise<BashExecResult> {
  const started = Date.now();
  const { abs: cwd } = safeWorkspacePath(project, ".");

  const timeoutMs = Math.max(
    MIN_TIMEOUT_MS,
    Math.min(HARD_MAX_TIMEOUT_MS, rawTimeout),
  );
  const maxOutput = Math.max(1024, rawMaxOutput);

  const env = filterEnv(project);

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  (timer as unknown as { unref?: () => void }).unref?.();

  const proc = Bun.spawn({
    cmd,
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    signal: controller.signal,
  });

  let output = "";
  let truncated = false;

  await Promise.all([drain(proc.stdout), drain(proc.stderr)]);
  const exitCode = await proc.exited;
  clearTimeout(timer);

  if (timedOut) {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* process already gone */
    }
    output += "\n…killed (timeout)";
  }
  if (truncated) output += "\n…truncated";

  const tail = output.length > 4096 ? output.slice(-4096) : output;
  return {
    exitCode,
    tail,
    output,
    truncated,
    durationMs: Date.now() - started,
    timedOut,
  };

  // Inner close over the outer-scope `truncated` / `output` / `onChunk`.
  async function drain(
    stream: ReadableStream<Uint8Array> | null,
  ): Promise<void> {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: false });
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        const chunk = decoder.decode(value, { stream: true });
        if (!truncated) {
          const remaining = maxOutput - output.length;
          if (remaining <= 0) {
            truncated = true;
          } else if (chunk.length <= remaining) {
            output += chunk;
          } else {
            output += chunk.slice(0, remaining);
            truncated = true;
          }
        }
        onChunk?.(chunk);
      }
    } catch {
      /* aborted — caller sees via exitCode/timedOut */
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
    }
  }
}
