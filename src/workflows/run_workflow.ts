/**
 * Workflow execution engine.
 *
 * Mirrors `src/board/run_card.ts:runCard` — detached async runner + in-memory
 * fanout keyed by runId. Nodes are dispatched in topological order; v1 is
 * strictly serial (no parallel sibling branches — out of scope per ADR 0032).
 *
 * Per node kind:
 *   - `prompt`      → one `runAgent` call, systemPromptOverride from the
 *                     `workflows.system_prompt` registry entry.
 *   - `bash`        → direct `executeBash` call (see `bash_exec.ts`). First
 *                     execution per (workflow, nodeId) pauses on an
 *                     `ask_user_question` approval gate; the sha256 is then
 *                     recorded on `workflows.bash_approvals`.
 *   - `loop`        → iterate up to `max_iterations`; each iteration is a
 *                     `runAgent` call. Completion = presence of the literal
 *                     `<<<${until}>>>` token in the final answer.
 *   - `interactive` → stand-alone `ask_user_question` gate, no LLM call.
 *
 * The umbrella session hosts all live SSE events so one `/stream` connection
 * can reconstruct the entire run. `fresh_context: true` on a loop iteration
 * mints a new sessionId (same project) so the agent loses history between
 * iterations.
 */

import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { BunnyConfig } from "../config.ts";
import type { BunnyQueue } from "../queue/bunqueue.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { Renderer } from "../agent/render.ts";
import {
  createSseRenderer,
  finishSse,
  type SseSink,
} from "../agent/render_sse.ts";
import {
  createFanout,
  createFanoutRegistry,
  sendSseEvent,
  subscribeFanout,
  type Fanout,
} from "../agent/run_fanout.ts";
import { runAgent, type RunAgentOptions } from "../agent/loop.ts";
import { errorMessage } from "../util/error.ts";
import {
  resolvePrompt,
  interpolate as promptInterpolate,
} from "../prompts/resolve.ts";
import {
  waitForAnswer,
  cancelPendingQuestion,
  cancelPendingQuestionsForSession,
} from "../agent/ask_user_registry.ts";

import {
  getWorkflow,
  grantBashApproval,
  type Workflow,
} from "../memory/workflows.ts";
import { loadWorkflowToml } from "../memory/workflow_assets.ts";
import {
  createRun,
  createRunNode,
  listRecentRunNodeSummaries,
  markNodeDone,
  markNodeError,
  markNodeSkipped,
  markNodeWaiting,
  markRunCancelled,
  markRunDone,
  markRunError,
  type RunStep,
  type WorkflowRun,
} from "../memory/workflow_runs.ts";
import {
  computeTopo,
  parseWorkflowToml,
  type ForEachSpec,
  type IfThenElseSpec,
  type WorkflowDef,
  type WorkflowNode,
} from "./schema.ts";
import { executeBash, executeScript, hashCommand } from "./bash_exec.ts";
import { NodeStepBuffer } from "./node_step_buffer.ts";

// ── Run context (variable interpolation + node outputs) ─────────────────────

/**
 * Shared state threaded through every node invocation inside one run.
 * Body-owning nodes (for_each, if_then_else) snapshot the parent context,
 * augment `vars` with iteration/item bindings, and pass the child context
 * to body nodes. Node outputs are recorded in `nodes` so downstream
 * interpolations like `{{nodes.foo.output}}` resolve.
 */
export interface RunContext {
  nodes: Record<string, string>;
  vars: Record<string, string>;
}

/** One-call invocation envelope — carries the DB iteration hint + ctx. */
interface InvocationCtx {
  runCtx: RunContext;
  iteration: number;
}

/**
 * Interpolate `{{var}}` tokens in a string. Supported vars:
 *  - `nodes.<id>.output` — the stored output of another node.
 *  - any key in `ctx.vars` (e.g. `iteration`, `item`, or user-named
 *    variables set by an enclosing for_each).
 * Unknown tokens are replaced with the empty string — deliberately lenient
 * so a run doesn't fail hard on a dangling reference.
 */
export function interpolate(tpl: string, ctx: RunContext): string {
  return tpl.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_m, raw: string) => {
    const key = String(raw).trim();
    if (key.startsWith("nodes.")) {
      const parts = key.split(".");
      if (parts.length === 3 && parts[2] === "output") {
        return ctx.nodes[parts[1]!] ?? "";
      }
      return "";
    }
    return ctx.vars[key] ?? "";
  });
}

/**
 * Resolve a for_each's items. `spec.count` short-circuits to `[1..N]`;
 * `spec.items` is interpolated, then parsed as JSON (array or number);
 * otherwise the string is split on newlines.
 */
export function resolveForEachItems(
  spec: ForEachSpec,
  ctx: RunContext,
): unknown[] {
  if (spec.count !== undefined) {
    const s = interpolate(spec.count, ctx).trim();
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0) return [];
    const cap = Math.floor(Math.min(1000, n));
    const out: number[] = [];
    for (let i = 1; i <= cap; i++) out.push(i);
    return out;
  }
  if (spec.items !== undefined) {
    const s = interpolate(spec.items, ctx).trim();
    if (!s) return [];
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) return parsed;
      if (typeof parsed === "number" && parsed > 0) {
        const cap = Math.floor(Math.min(1000, parsed));
        const out: number[] = [];
        for (let i = 1; i <= cap; i++) out.push(i);
        return out;
      }
    } catch {
    }
    return s
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * Evaluate an if_then_else condition. Post-interpolation the value is
 * trimmed and lowercased; empty / "0" / "false" / "no" / "null" → false.
 * Everything else → true. Simple on purpose (no operators).
 */
export function evalCondition(expr: string, ctx: RunContext): boolean {
  const s = interpolate(expr, ctx).trim().toLowerCase();
  if (!s) return false;
  return !(s === "0" || s === "false" || s === "no" || s === "null");
}

/** Normalise any value (including numbers/objects) to the string form we store in `nodes[id]`. */
function outputToString(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// ── Fanout (thin wrapper around the shared `run_fanout` module) ─────────────

interface WorkflowFanoutMeta {
  sessionId: string;
  cancelRequested: boolean;
}
export type WorkflowRunFanout = Fanout<WorkflowFanoutMeta>;

const fanouts = createFanoutRegistry<WorkflowFanoutMeta>();

export function getWorkflowRunFanout(
  runId: number,
): WorkflowRunFanout | undefined {
  return fanouts.get(runId);
}

export function subscribeToWorkflowRun(
  runId: number,
  sink: SseSink,
): () => void {
  return subscribeFanout(fanouts, runId, sink);
}

export function requestCancelWorkflowRun(runId: number): boolean {
  const fan = fanouts.get(runId);
  if (!fan || fan.closed) return false;
  fan.meta.cancelRequested = true;
  // Unblock anything parked in `waitForAnswer` for this run's umbrella
  // session. Without this, an interactive node would sit on the 15-minute
  // ask-user timeout before the cancel flag is ever observed.
  cancelPendingQuestionsForSession(fan.meta.sessionId, "workflow cancelled");
  return true;
}

const sendEvent = sendSseEvent;

// ── Node lifecycle helpers ──────────────────────────────────────────────────
//
// Every node dispatcher emits the same triplet on success/failure:
// persist the DB state, send the SSE `workflow_node_finished` event, log
// to the queue. Wrapping all three keeps them in lock-step — an earlier
// version silently skipped the queue.log on a few error branches which
// hid failed-node signals from the audit topic.

interface NodeRowHandle {
  id: number;
  iteration: number;
}

function emitNodeStarted(
  run: WorkflowRun,
  sink: SseSink,
  rn: NodeRowHandle,
  node: WorkflowNode,
): void {
  sendEvent(sink, {
    type: "workflow_node_started",
    runId: run.id,
    runNodeId: rn.id,
    nodeId: node.id,
    kind: node.kind,
    iteration: rn.iteration,
  });
}

function emitNodeDone(
  opts: RunWorkflowOpts,
  run: WorkflowRun,
  sink: SseSink,
  rn: NodeRowHandle,
  node: WorkflowNode,
  resultText: string,
  extra: { logText?: string | null; steps?: RunStep[] | null } = {},
): void {
  markNodeDone(opts.db, rn.id, {
    resultText,
    logText: extra.logText ?? null,
    steps: extra.steps ?? null,
  });
  sendEvent(sink, {
    type: "workflow_node_finished",
    runId: run.id,
    runNodeId: rn.id,
    nodeId: node.id,
    iteration: rn.iteration,
    status: "done",
    resultText,
  });
  void opts.queue.log({
    topic: "workflows",
    kind: "run.node.finish",
    userId: opts.triggeredBy,
    data: {
      runId: run.id,
      nodeId: node.id,
      kind: node.kind,
      iteration: rn.iteration,
    },
  });
}

function emitNodeFailure(
  opts: RunWorkflowOpts,
  run: WorkflowRun,
  sink: SseSink,
  rn: NodeRowHandle,
  node: WorkflowNode,
  error: string,
  extra: { logText?: string | null; steps?: RunStep[] | null } = {},
): void {
  markNodeError(
    opts.db,
    rn.id,
    error,
    extra.logText ?? null,
    extra.steps ?? null,
  );
  sendEvent(sink, {
    type: "workflow_node_finished",
    runId: run.id,
    runNodeId: rn.id,
    nodeId: node.id,
    iteration: rn.iteration,
    status: "error",
    error,
  });
  void opts.queue.log({
    topic: "workflows",
    kind: "run.node.error",
    userId: opts.triggeredBy,
    data: {
      runId: run.id,
      nodeId: node.id,
      kind: node.kind,
      iteration: rn.iteration,
      error,
    },
  });
}

// ── Opts ─────────────────────────────────────────────────────────────────────

export interface RunWorkflowOpts {
  db: Database;
  queue: BunnyQueue;
  cfg: BunnyConfig;
  tools: ToolRegistry;
  workflowId: number;
  triggeredBy: string;
  triggerKind?: "manual" | "scheduled" | "api";
  /** Test seam — inject a mock runAgent. */
  runAgentImpl?: (opts: RunAgentOptions) => Promise<string>;
}

export interface RunWorkflowResult {
  run: WorkflowRun;
  sessionId: string;
}

// ── Public entry ─────────────────────────────────────────────────────────────

/**
 * Start a workflow run. Returns immediately; detached task runs the engine
 * and streams events into the per-run fanout.
 *
 * Route layer is responsible for:
 *  - Verifying the caller is allowed to edit this project.
 *  - Rejecting early with 403 when bash nodes are present and the
 *    `[workflows] bash_enabled` flag is off (this layer also re-checks at
 *    dispatch time so misconfiguration can't bypass the gate).
 */
export function runWorkflow(opts: RunWorkflowOpts): RunWorkflowResult {
  const wf = getWorkflow(opts.db, opts.workflowId);
  if (!wf) throw new Error(`workflow ${opts.workflowId} not found`);

  const tomlText = loadWorkflowToml(wf.project, wf.slug);
  if (tomlText === null) {
    throw new Error(`workflow '${wf.slug}': TOML file missing on disk`);
  }

  // Parse up-front so the caller can 400 on malformed TOML. If parsing fails
  // we still record a run row (status=error) for audit, but we report the
  // error synchronously rather than emitting SSE events the UI can't reach.
  const parsed = parseWorkflowToml(tomlText);
  if (!parsed.def) {
    const msg = `workflow parse failed: ${parsed.errors.join("; ")}`;
    throw new Error(msg);
  }

  const sessionId = randomUUID();
  const run = createRun(opts.db, {
    workflowId: wf.id,
    project: wf.project,
    sessionId,
    tomlSnapshot: tomlText,
    triggerKind: opts.triggerKind ?? "manual",
    triggeredBy: opts.triggeredBy,
  });

  const { fanout: fan, sink } = createFanout(fanouts, {
    runId: run.id,
    meta: { sessionId, cancelRequested: false },
  });
  sendEvent(sink, {
    type: "workflow_run_started",
    runId: run.id,
    workflowId: wf.id,
    sessionId,
  });

  void opts.queue.log({
    topic: "workflows",
    kind: "run.start",
    userId: opts.triggeredBy,
    data: {
      workflowId: wf.id,
      runId: run.id,
      project: wf.project,
      slug: wf.slug,
      trigger: run.triggerKind,
    },
  });

  void executeRun(opts, wf, run, parsed.def, sink, fan).finally(() =>
    finishSse(sink),
  );

  return { run, sessionId };
}

// ── Engine ───────────────────────────────────────────────────────────────────

async function executeRun(
  opts: RunWorkflowOpts,
  wf: Workflow,
  run: WorkflowRun,
  def: WorkflowDef,
  sink: SseSink,
  fan: WorkflowRunFanout,
): Promise<void> {
  const runAgentFn = opts.runAgentImpl ?? runAgent;
  let order: string[];
  try {
    order = computeTopo(def);
  } catch (e) {
    const msg = errorMessage(e);
    markRunError(opts.db, run.id, msg);
    sendEvent(sink, {
      type: "workflow_run_finished",
      runId: run.id,
      status: "error",
      error: msg,
    });
    void opts.queue.log({
      topic: "workflows",
      kind: "run.error",
      userId: opts.triggeredBy,
      data: { runId: run.id, error: msg },
    });
    return;
  }

  const nodesById = new Map<string, WorkflowNode>();
  for (const n of def.nodes) nodesById.set(n.id, n);

  // Body-owned nodes are dispatched by their owner (for_each / if_then_else),
  // never at the top level. The parser already enforces one-owner-per-node.
  const owned = computeOwnedSet(def);
  const topLevelOrder = order.filter((id) => !owned.has(id));

  const runCtx: RunContext = { nodes: {}, vars: {} };

  for (const nodeId of topLevelOrder) {
    if (fan.meta.cancelRequested) {
      markRunCancelled(opts.db, run.id);
      sendEvent(sink, {
        type: "workflow_run_finished",
        runId: run.id,
        status: "cancelled",
      });
      void opts.queue.log({
        topic: "workflows",
        kind: "run.cancel",
        userId: opts.triggeredBy,
        data: { runId: run.id },
      });
      return;
    }
    const node = nodesById.get(nodeId)!;
    const exec = await dispatchNode(
      opts,
      wf,
      run,
      def,
      node,
      sink,
      fan,
      runAgentFn,
      nodesById,
      { runCtx, iteration: 0 },
    );
    if (exec.status === "error") {
      const msg = exec.error ?? "node error";
      markRunError(opts.db, run.id, msg);
      sendEvent(sink, {
        type: "workflow_run_finished",
        runId: run.id,
        status: "error",
        error: msg,
      });
      void opts.queue.log({
        topic: "workflows",
        kind: "run.error",
        userId: opts.triggeredBy,
        data: { runId: run.id, nodeId, error: msg },
      });
      return;
    }
    if (exec.status === "cancelled") {
      markRunCancelled(opts.db, run.id);
      sendEvent(sink, {
        type: "workflow_run_finished",
        runId: run.id,
        status: "cancelled",
      });
      void opts.queue.log({
        topic: "workflows",
        kind: "run.cancel",
        userId: opts.triggeredBy,
        data: { runId: run.id, nodeId },
      });
      return;
    }
    if (exec.resultText !== undefined) {
      runCtx.nodes[nodeId] = exec.resultText;
    }
  }

  markRunDone(opts.db, run.id);
  sendEvent(sink, {
    type: "workflow_run_finished",
    runId: run.id,
    status: "done",
  });
  void opts.queue.log({
    topic: "workflows",
    kind: "run.finish",
    userId: opts.triggeredBy,
    data: { runId: run.id },
  });
}

interface NodeExecResult {
  status: "done" | "error" | "cancelled";
  resultText?: string;
  error?: string;
}

function computeOwnedSet(def: WorkflowDef): Set<string> {
  const owned = new Set<string>();
  for (const n of def.nodes) {
    if (n.for_each) for (const b of n.for_each.body) owned.add(b);
    if (n.if_then_else) {
      for (const b of n.if_then_else.then_body) owned.add(b);
      for (const b of n.if_then_else.else_body) owned.add(b);
    }
  }
  return owned;
}

async function dispatchNode(
  opts: RunWorkflowOpts,
  wf: Workflow,
  run: WorkflowRun,
  def: WorkflowDef,
  node: WorkflowNode,
  sink: SseSink,
  fan: WorkflowRunFanout,
  runAgentFn: (opts: RunAgentOptions) => Promise<string>,
  nodesById: Map<string, WorkflowNode>,
  inv: InvocationCtx,
): Promise<NodeExecResult> {
  const kind = node.kind;

  // Kind-specific guardrails BEFORE we open a run-node row.
  const gateDisabled =
    (kind === "bash" && !opts.cfg.workflows.bashEnabled) ||
    (kind === "script" && !opts.cfg.workflows.scriptEnabled);
  if (gateDisabled) {
    const rn = createRunNode(opts.db, {
      runId: run.id,
      nodeId: node.id,
      kind,
      iteration: inv.iteration,
    });
    const flag = kind === "bash" ? "bash_enabled" : "script_enabled";
    const msg = `${kind} is disabled — set [workflows] ${flag} = true to allow`;
    markNodeError(opts.db, rn.id, msg);
    sendEvent(sink, {
      type: "workflow_node_started",
      runId: run.id,
      runNodeId: rn.id,
      nodeId: node.id,
      kind,
      iteration: rn.iteration,
    });
    sendEvent(sink, {
      type: "workflow_node_finished",
      runId: run.id,
      runNodeId: rn.id,
      nodeId: node.id,
      iteration: rn.iteration,
      status: "error",
      error: msg,
    });
    return { status: "error", error: msg };
  }

  switch (kind) {
    case "prompt":
      return dispatchPrompt(opts, wf, run, def, node, sink, runAgentFn, inv);
    case "bash":
      return dispatchBash(opts, wf, run, node, sink, fan, inv);
    case "script":
      return dispatchScript(opts, wf, run, node, sink, fan, inv);
    case "loop":
      return dispatchLoop(opts, wf, run, def, node, sink, fan, runAgentFn, inv);
    case "interactive":
      return dispatchInteractive(opts, wf, run, def, node, sink, fan, inv);
    case "for_each":
      return dispatchForEach(
        opts,
        wf,
        run,
        def,
        node,
        sink,
        fan,
        runAgentFn,
        nodesById,
        inv,
      );
    case "if_then_else":
      return dispatchIfThenElse(
        opts,
        wf,
        run,
        def,
        node,
        sink,
        fan,
        runAgentFn,
        nodesById,
        inv,
      );
  }
}

// ── Prompt nodes ─────────────────────────────────────────────────────────────

async function dispatchPrompt(
  opts: RunWorkflowOpts,
  wf: Workflow,
  run: WorkflowRun,
  def: WorkflowDef,
  node: WorkflowNode,
  sink: SseSink,
  runAgentFn: (opts: RunAgentOptions) => Promise<string>,
  inv: InvocationCtx,
): Promise<NodeExecResult> {
  const rn = createRunNode(opts.db, {
    runId: run.id,
    nodeId: node.id,
    kind: node.kind,
    iteration: inv.iteration,
    childSessionId: run.sessionId,
  });
  emitNodeStarted(run, sink, rn, node);

  const buffer = new NodeStepBuffer();
  const renderer = makeNodeRenderer(sink, node.id, buffer);
  const systemPrompt = composeNodeSystemPrompt(wf, def, node);
  const agentName = node.agent?.trim() || opts.cfg.agent.defaultAgent;
  const interpolatedPrompt = interpolate(node.prompt ?? "", inv.runCtx);

  try {
    const finalAnswer = await runAgentFn({
      prompt: interpolatedPrompt,
      sessionId: run.sessionId,
      userId: opts.triggeredBy,
      project: wf.project,
      agent: agentName,
      llmCfg: opts.cfg.llm,
      embedCfg: opts.cfg.embed,
      memoryCfg: opts.cfg.memory,
      agentCfg: opts.cfg.agent,
      webCfg: opts.cfg.web,
      tools: opts.tools,
      db: opts.db,
      queue: opts.queue,
      renderer,
      systemPromptOverride: systemPrompt,
      askUserEnabled: false,
      mentionsEnabled: false,
    });
    const steps = buffer.finalize();
    emitNodeDone(opts, run, sink, rn, node, finalAnswer, {
      logText: buffer.asLogText(),
      steps,
    });
    inv.runCtx.nodes[node.id] = finalAnswer;
    return { status: "done", resultText: finalAnswer };
  } catch (e) {
    const msg = errorMessage(e);
    const steps = buffer.finalize();
    emitNodeFailure(opts, run, sink, rn, node, msg, {
      logText: buffer.asLogText(),
      steps,
    });
    return { status: "error", error: msg };
  }
}

// ── Shell-like nodes (bash + script) ────────────────────────────────────────

interface ShellSpec {
  /** "bash" | "script" — drives step kind, log kinds, error labels. */
  kind: "bash" | "script";
  /** The interpolated source (shell command or JS/TS code). */
  source: string;
  /** Unique suffix for ask_user question id + extra prefix for cmdSha so bash/script hashes don't collide. */
  cmdShaInput: string;
  /** Text shown inside the first-run approval dialog. */
  approvalSubject: string;
  /** Fire the right executor. */
  execute(onChunk: (chunk: string) => void): Promise<{
    exitCode: number;
    tail: string;
    durationMs: number;
    truncated: boolean;
    timedOut: boolean;
  }>;
}

async function dispatchShellLike(
  opts: RunWorkflowOpts,
  wf: Workflow,
  run: WorkflowRun,
  node: WorkflowNode,
  sink: SseSink,
  fan: WorkflowRunFanout,
  inv: InvocationCtx,
  spec: ShellSpec,
): Promise<NodeExecResult> {
  const rn = createRunNode(opts.db, {
    runId: run.id,
    nodeId: node.id,
    kind: node.kind,
    iteration: inv.iteration,
  });
  emitNodeStarted(run, sink, rn, node);

  const cmdSha = hashCommand(spec.cmdShaInput);

  // First-run approval per (workflow, node, source-hash). The approval map
  // is shared so a node can't flip kinds to slip past approval.
  if (wf.bashApprovals[node.id] !== cmdSha) {
    markNodeWaiting(opts.db, rn.id);
    const questionId = `run:${run.id}:node:${node.id}:${spec.kind}`;
    const promptText = promptInterpolate(
      resolvePrompt("workflows.bash.confirmation_prompt", {
        project: wf.project,
      }),
      { command: spec.approvalSubject, nodeId: node.id },
    );
    sendEvent(sink, {
      type: "ask_user_question",
      questionId,
      question: promptText,
      options: ["Approve", "Deny"],
      allowCustom: false,
      multiSelect: false,
      author: `workflow:${wf.slug}`,
    });
    let answer: string;
    try {
      answer = await waitForAnswer(run.sessionId, questionId);
    } catch (e) {
      if (fan.meta.cancelRequested) {
        markNodeSkipped(opts.db, rn.id);
        return { status: "cancelled" };
      }
      const msg = errorMessage(e);
      emitNodeFailure(opts, run, sink, rn, node, msg);
      return { status: "error", error: msg };
    }
    if (answer.trim().toLowerCase() !== "approve") {
      const msg = `${spec.kind} approval denied: ${answer}`;
      emitNodeFailure(opts, run, sink, rn, node, msg);
      return { status: "error", error: msg };
    }
    grantBashApproval(opts.db, wf.id, node.id, cmdSha);
    wf.bashApprovals[node.id] = cmdSha;
    void opts.queue.log({
      topic: "workflows",
      kind: `${spec.kind}.approval.granted`,
      userId: opts.triggeredBy,
      data: { workflowId: wf.id, nodeId: node.id, cmdSha },
    });
  }

  const buffer: string[] = [];
  const startedAt = Date.now();
  const makeStep = (okOverride?: { ok: boolean; error?: string }): RunStep => ({
    kind: spec.kind,
    label: spec.kind,
    summary:
      spec.source.length > 160 ? spec.source.slice(0, 160) + "…" : spec.source,
    output: buffer.join(""),
    ok: okOverride?.ok ?? true,
    error: okOverride?.error,
    startedAt,
    durationMs: Date.now() - startedAt,
  });
  try {
    const result = await spec.execute((chunk) => {
      buffer.push(chunk);
      sendEvent(sink, {
        type: "content",
        text: chunk,
        author: `node:${node.id}`,
      });
    });

    void opts.queue.log({
      topic: "workflows",
      kind: `${spec.kind}.execute`,
      userId: opts.triggeredBy,
      data: {
        workflowId: wf.id,
        runId: run.id,
        nodeId: node.id,
        cmdSha,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        truncated: result.truncated,
        timedOut: result.timedOut,
      },
    });

    const ok = result.exitCode === 0 && !result.timedOut;
    if (!ok) {
      const err = result.timedOut
        ? `${spec.kind} timed out after ${result.durationMs}ms`
        : `${spec.kind} exited with code ${result.exitCode}`;
      emitNodeFailure(opts, run, sink, rn, node, err, {
        logText: buffer.join(""),
        steps: [makeStep({ ok: false, error: err })],
      });
      return { status: "error", error: err };
    }
    emitNodeDone(opts, run, sink, rn, node, result.tail, {
      logText: buffer.join(""),
      steps: [makeStep({ ok: true })],
    });
    inv.runCtx.nodes[node.id] = result.tail;
    return { status: "done", resultText: result.tail };
  } catch (e) {
    const msg = errorMessage(e);
    emitNodeFailure(opts, run, sink, rn, node, msg, {
      logText: buffer.join(""),
      steps: [makeStep({ ok: false, error: msg })],
    });
    return { status: "error", error: msg };
  }
}

function dispatchBash(
  opts: RunWorkflowOpts,
  wf: Workflow,
  run: WorkflowRun,
  node: WorkflowNode,
  sink: SseSink,
  fan: WorkflowRunFanout,
  inv: InvocationCtx,
): Promise<NodeExecResult> {
  const command = interpolate(node.bash ?? "", inv.runCtx);
  return dispatchShellLike(opts, wf, run, node, sink, fan, inv, {
    kind: "bash",
    source: command,
    cmdShaInput: command,
    approvalSubject: command,
    execute: (onChunk) =>
      executeBash({
        project: wf.project,
        command,
        timeoutMs: node.timeout_ms,
        cfg: opts.cfg.workflows,
        onChunk,
      }),
  });
}

function dispatchScript(
  opts: RunWorkflowOpts,
  wf: Workflow,
  run: WorkflowRun,
  node: WorkflowNode,
  sink: SseSink,
  fan: WorkflowRunFanout,
  inv: InvocationCtx,
): Promise<NodeExecResult> {
  const code = interpolate(node.script ?? "", inv.runCtx);
  return dispatchShellLike(opts, wf, run, node, sink, fan, inv, {
    kind: "script",
    source: code,
    // Prefix so a `script` node can't collide with a `bash` node that happens
    // to share the same text (highly unlikely but the approval map is shared).
    cmdShaInput: `script:${code}`,
    approvalSubject: `bun -e …\n${code}`,
    execute: (onChunk) =>
      executeScript({
        project: wf.project,
        code,
        timeoutMs: node.timeout_ms,
        cfg: opts.cfg.workflows,
        onChunk,
      }),
  });
}

// ── Loop nodes ───────────────────────────────────────────────────────────────

async function dispatchLoop(
  opts: RunWorkflowOpts,
  wf: Workflow,
  run: WorkflowRun,
  def: WorkflowDef,
  node: WorkflowNode,
  sink: SseSink,
  fan: WorkflowRunFanout,
  runAgentFn: (opts: RunAgentOptions) => Promise<string>,
  inv: InvocationCtx,
): Promise<NodeExecResult> {
  const loop = node.loop!;
  const maxIters = Math.max(
    1,
    Math.min(
      100,
      loop.max_iterations ?? opts.cfg.workflows.loopDefaultMaxIterations,
    ),
  );
  const stopToken = `<<<${loop.until}>>>`;
  let lastAnswer: string | undefined;

  for (let iter = 1; iter <= maxIters; iter++) {
    if (fan.meta.cancelRequested) return { status: "cancelled" };

    const iterationSessionId = loop.fresh_context ? randomUUID() : run.sessionId;
    const rn = createRunNode(opts.db, {
      runId: run.id,
      nodeId: node.id,
      kind: node.kind,
      iteration: iter,
      childSessionId: iterationSessionId,
    });
    sendEvent(sink, {
      type: "workflow_node_started",
      runId: run.id,
      runNodeId: rn.id,
      nodeId: node.id,
      kind: "loop",
      iteration: iter,
    });

    const preamble = promptInterpolate(
      resolvePrompt("workflows.loop.preamble", { project: wf.project }),
      {
        stopToken,
        iteration: iter,
        maxIterations: maxIters,
        until: loop.until,
      },
    );
    const prompt = interpolate(loop.prompt, inv.runCtx) + preamble;
    const systemPrompt = composeNodeSystemPrompt(wf, def, node);
    const agentName = node.agent?.trim() || opts.cfg.agent.defaultAgent;

    const buffer = new NodeStepBuffer();
    const renderer = makeNodeRenderer(sink, node.id, buffer);

    try {
      const finalAnswer = await runAgentFn({
        prompt,
        sessionId: iterationSessionId,
        userId: opts.triggeredBy,
        project: wf.project,
        agent: agentName,
        llmCfg: opts.cfg.llm,
        embedCfg: opts.cfg.embed,
        memoryCfg: opts.cfg.memory,
        agentCfg: opts.cfg.agent,
        webCfg: opts.cfg.web,
        tools: opts.tools,
        db: opts.db,
        queue: opts.queue,
        renderer,
        systemPromptOverride: systemPrompt,
        askUserEnabled: loop.interactive === true,
        mentionsEnabled: false,
      });
      lastAnswer = finalAnswer;
      const iterSteps = buffer.finalize();
      markNodeDone(opts.db, rn.id, {
        resultText: finalAnswer,
        logText: buffer.asLogText(),
        steps: iterSteps,
      });
      sendEvent(sink, {
        type: "workflow_node_finished",
        runId: run.id,
        runNodeId: rn.id,
        nodeId: node.id,
        iteration: iter,
        status: "done",
        resultText: finalAnswer,
      });
      if (finalAnswer.includes(stopToken)) {
        inv.runCtx.nodes[node.id] = finalAnswer;
        return { status: "done", resultText: finalAnswer };
      }
    } catch (e) {
      const msg = errorMessage(e);
      const iterSteps = buffer.finalize();
      markNodeError(opts.db, rn.id, msg, buffer.asLogText(), iterSteps);
      sendEvent(sink, {
        type: "workflow_node_finished",
        runId: run.id,
        runNodeId: rn.id,
        nodeId: node.id,
        iteration: iter,
        status: "error",
        error: msg,
      });
      return { status: "error", error: msg };
    }
  }

  // Exhausted.
  const err = `loop: did not reach stop condition '${loop.until}' within ${maxIters} iterations`;
  // Record the overflow on a synthetic iteration 0 row to make it surface in
  // listRunNodes without clobbering the last iteration's record.
  const exhaustRn = createRunNode(opts.db, {
    runId: run.id,
    nodeId: node.id,
    kind: "loop",
    iteration: maxIters + 1,
  });
  markNodeError(opts.db, exhaustRn.id, err);
  sendEvent(sink, {
    type: "workflow_node_finished",
    runId: run.id,
    runNodeId: exhaustRn.id,
    nodeId: node.id,
    iteration: maxIters + 1,
    status: "error",
    error: err,
  });
  return { status: "error", error: err + (lastAnswer ? ` (last answer bytes: ${lastAnswer.length})` : "") };
}

// ── Interactive (stand-alone) ────────────────────────────────────────────────

async function dispatchInteractive(
  opts: RunWorkflowOpts,
  wf: Workflow,
  run: WorkflowRun,
  _def: WorkflowDef,
  node: WorkflowNode,
  sink: SseSink,
  fan: WorkflowRunFanout,
  inv: InvocationCtx,
): Promise<NodeExecResult> {
  const rn = createRunNode(opts.db, {
    runId: run.id,
    nodeId: node.id,
    kind: node.kind,
    iteration: inv.iteration,
  });
  sendEvent(sink, {
    type: "workflow_node_started",
    runId: run.id,
    runNodeId: rn.id,
    nodeId: node.id,
    kind: "interactive",
    iteration: rn.iteration,
  });
  markNodeWaiting(opts.db, rn.id);

  // Summarise prior node results so the user has context. Use the lean
  // summary query so we don't pull megabytes of log_text / steps_json just
  // to truncate each to 400 chars.
  const prior = listRecentRunNodeSummaries(opts.db, run.id, 6)
    .filter((n) => n.nodeId !== node.id && (n.resultText || n.error))
    .slice(-5)
    .map(
      (n) =>
        `- ${n.nodeId}${n.iteration ? `(i${n.iteration})` : ""}: ${
          n.resultText ?? n.error ?? ""
        }`,
    )
    .join("\n");

  const questionId = `run:${run.id}:node:${node.id}:approve`;
  const question = promptInterpolate(
    resolvePrompt("workflows.interactive.approval_preamble", {
      project: wf.project,
    }),
    { priorResults: prior || "(none)" },
  );

  sendEvent(sink, {
    type: "ask_user_question",
    questionId,
    question,
    options: ["Approve", "Reject"],
    allowCustom: true,
    multiSelect: false,
    author: `workflow:${wf.slug}`,
  });

  let answer: string;
  try {
    answer = await waitForAnswer(run.sessionId, questionId);
  } catch (e) {
    if (fan.meta.cancelRequested) {
      cancelPendingQuestion(run.sessionId, questionId, "workflow cancelled");
      markNodeSkipped(opts.db, rn.id);
      return { status: "cancelled" };
    }
    const msg = errorMessage(e);
    markNodeError(opts.db, rn.id, msg);
    sendEvent(sink, {
      type: "workflow_node_finished",
      runId: run.id,
      runNodeId: rn.id,
      nodeId: node.id,
      iteration: rn.iteration,
      status: "error",
      error: msg,
    });
    return { status: "error", error: msg };
  }
  if (answer.trim().toLowerCase().startsWith("reject")) {
    const msg = `rejected by user: ${answer}`;
    markNodeError(opts.db, rn.id, msg, answer);
    sendEvent(sink, {
      type: "workflow_node_finished",
      runId: run.id,
      runNodeId: rn.id,
      nodeId: node.id,
      iteration: rn.iteration,
      status: "error",
      error: msg,
    });
    return { status: "error", error: msg };
  }
  markNodeDone(opts.db, rn.id, { resultText: answer });
  sendEvent(sink, {
    type: "workflow_node_finished",
    runId: run.id,
    runNodeId: rn.id,
    nodeId: node.id,
    iteration: rn.iteration,
    status: "done",
    resultText: answer,
  });
  inv.runCtx.nodes[node.id] = answer;
  return { status: "done", resultText: answer };
}

// ── For-each nodes ──────────────────────────────────────────────────────────

async function dispatchForEach(
  opts: RunWorkflowOpts,
  wf: Workflow,
  run: WorkflowRun,
  def: WorkflowDef,
  node: WorkflowNode,
  sink: SseSink,
  fan: WorkflowRunFanout,
  runAgentFn: (opts: RunAgentOptions) => Promise<string>,
  nodesById: Map<string, WorkflowNode>,
  inv: InvocationCtx,
): Promise<NodeExecResult> {
  const spec = node.for_each!;
  const cap = Math.max(
    1,
    Math.min(1000, spec.max_iterations ?? 50),
  );
  const items = resolveForEachItems(spec, inv.runCtx).slice(0, cap);

  const rn = createRunNode(opts.db, {
    runId: run.id,
    nodeId: node.id,
    kind: node.kind,
    iteration: inv.iteration,
  });
  sendEvent(sink, {
    type: "workflow_node_started",
    runId: run.id,
    runNodeId: rn.id,
    nodeId: node.id,
    kind: "for_each",
    iteration: rn.iteration,
  });

  const itemVarName = spec.item_var?.trim() || "item";
  const indexVarName = spec.index_var?.trim() || "iteration";

  if (items.length === 0) {
    markNodeDone(opts.db, rn.id, {
      resultText: "(no items)",
      logText: "No items produced by the for_each source.",
    });
    sendEvent(sink, {
      type: "workflow_node_finished",
      runId: run.id,
      runNodeId: rn.id,
      nodeId: node.id,
      iteration: rn.iteration,
      status: "done",
      resultText: "(no items)",
    });
    inv.runCtx.nodes[node.id] = "";
    return { status: "done", resultText: "" };
  }

  for (let i = 0; i < items.length; i++) {
    if (fan.meta.cancelRequested) return { status: "cancelled" };
    const item = items[i];
    const itemStr = outputToString(item);
    const indexStr = String(i + 1);
    const childVars: Record<string, string> = {
      ...inv.runCtx.vars,
      [itemVarName]: itemStr,
      [indexVarName]: indexStr,
    };
    if (itemVarName !== "item") childVars["item"] = itemStr;
    if (indexVarName !== "iteration") childVars["iteration"] = indexStr;
    const childCtx: RunContext = { nodes: inv.runCtx.nodes, vars: childVars };
    for (const bid of spec.body) {
      if (fan.meta.cancelRequested) return { status: "cancelled" };
      const bodyNode = nodesById.get(bid);
      if (!bodyNode) continue;
      const result = await dispatchNode(
        opts,
        wf,
        run,
        def,
        bodyNode,
        sink,
        fan,
        runAgentFn,
        nodesById,
        { runCtx: childCtx, iteration: i + 1 },
      );
      if (result.status === "error") {
        const msg =
          `for_each '${node.id}': iteration ${i + 1} failed in '${bid}': ${result.error ?? "error"}`;
        markNodeError(opts.db, rn.id, msg);
        sendEvent(sink, {
          type: "workflow_node_finished",
          runId: run.id,
          runNodeId: rn.id,
          nodeId: node.id,
          iteration: rn.iteration,
          status: "error",
          error: msg,
        });
        return { status: "error", error: msg };
      }
      if (result.status === "cancelled") return { status: "cancelled" };
    }
  }

  const summary = `iterated ${items.length} time${items.length === 1 ? "" : "s"}`;
  markNodeDone(opts.db, rn.id, {
    resultText: summary,
    logText: summary,
  });
  sendEvent(sink, {
    type: "workflow_node_finished",
    runId: run.id,
    runNodeId: rn.id,
    nodeId: node.id,
    iteration: rn.iteration,
    status: "done",
    resultText: summary,
  });
  inv.runCtx.nodes[node.id] = summary;
  return { status: "done", resultText: summary };
}

// ── If-then-else nodes ──────────────────────────────────────────────────────

async function dispatchIfThenElse(
  opts: RunWorkflowOpts,
  wf: Workflow,
  run: WorkflowRun,
  def: WorkflowDef,
  node: WorkflowNode,
  sink: SseSink,
  fan: WorkflowRunFanout,
  runAgentFn: (opts: RunAgentOptions) => Promise<string>,
  nodesById: Map<string, WorkflowNode>,
  inv: InvocationCtx,
): Promise<NodeExecResult> {
  const spec = node.if_then_else!;
  const branch = evalCondition(spec.condition, inv.runCtx) ? "then" : "else";
  const ids = branch === "then" ? spec.then_body : spec.else_body;

  const rn = createRunNode(opts.db, {
    runId: run.id,
    nodeId: node.id,
    kind: node.kind,
    iteration: inv.iteration,
  });
  sendEvent(sink, {
    type: "workflow_node_started",
    runId: run.id,
    runNodeId: rn.id,
    nodeId: node.id,
    kind: "if_then_else",
    iteration: rn.iteration,
  });

  for (const bid of ids) {
    if (fan.meta.cancelRequested) return { status: "cancelled" };
    const bodyNode = nodesById.get(bid);
    if (!bodyNode) continue;
    const result = await dispatchNode(
      opts,
      wf,
      run,
      def,
      bodyNode,
      sink,
      fan,
      runAgentFn,
      nodesById,
      { runCtx: inv.runCtx, iteration: inv.iteration },
    );
    if (result.status === "error") {
      const msg =
        `if_then_else '${node.id}' (${branch}-branch): '${bid}' failed: ${result.error ?? "error"}`;
      markNodeError(opts.db, rn.id, msg);
      sendEvent(sink, {
        type: "workflow_node_finished",
        runId: run.id,
        runNodeId: rn.id,
        nodeId: node.id,
        iteration: rn.iteration,
        status: "error",
        error: msg,
      });
      return { status: "error", error: msg };
    }
    if (result.status === "cancelled") return { status: "cancelled" };
  }

  const summary = `took ${branch}-branch (${ids.length} step${ids.length === 1 ? "" : "s"})`;
  markNodeDone(opts.db, rn.id, {
    resultText: summary,
    logText: summary,
  });
  sendEvent(sink, {
    type: "workflow_node_finished",
    runId: run.id,
    runNodeId: rn.id,
    nodeId: node.id,
    iteration: rn.iteration,
    status: "done",
    resultText: summary,
  });
  inv.runCtx.nodes[node.id] = branch;
  return { status: "done", resultText: branch };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function composeNodeSystemPrompt(
  wf: Workflow,
  _def: WorkflowDef,
  node: WorkflowNode,
): string {
  return promptInterpolate(
    resolvePrompt("workflows.system_prompt", { project: wf.project }),
    {
      workflowName: wf.name,
      nodeId: node.id,
      nodeKind: node.kind,
    },
  );
}

/**
 * Wrap `createSseRenderer` so every content/reasoning delta + tool_result is
 * appended to a structured per-node step buffer. Steps are persisted to
 * `workflow_run_nodes.steps_json` when the node finishes so the run-view
 * timeline can render them. The same buffer also produces the plain-text
 * `log_text` for backward-compat viewers.
 */
function makeNodeRenderer(
  sink: SseSink,
  nodeId: string,
  buffer: NodeStepBuffer,
): Renderer {
  const inner = createSseRenderer(sink, { author: `node:${nodeId}` });
  return {
    onDelta(delta) {
      if (delta.channel === "content" || delta.channel === "reasoning") {
        buffer.onText(delta.channel, delta.text);
      } else if (delta.channel === "tool_call") {
        buffer.onToolCallDelta(delta.callIndex, delta.name, delta.argsDelta);
      }
      inner.onDelta(delta);
    },
    onToolResult(name, result) {
      buffer.onToolResult(name, result.ok, result.output ?? "", result.error);
      inner.onToolResult(name, result);
    },
    onStats(stats) {
      inner.onStats(stats);
    },
    onError(msg) {
      inner.onError(msg);
    },
    onTurnEnd() {
      inner.onTurnEnd();
    },
    onAskUserQuestion(ev) {
      inner.onAskUserQuestion?.(ev);
    },
  };
}

