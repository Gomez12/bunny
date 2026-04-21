import { useEffect, useMemo, useState } from "react";
import type {
  WorkflowRunDto,
  WorkflowRunNodeDto,
  WorkflowRunStep,
} from "../../api";
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  Terminal,
  MessageSquareMore,
  CheckCircle,
  AlertCircle,
  User,
  RotateCcw,
} from "../../lib/icons";

interface Props {
  run: WorkflowRunDto;
  nodes: WorkflowRunNodeDto[];
  /**
   * Live per-run-node-id step lists built from SSE events. Used for the
   * currently-running node where `steps_json` has not been persisted yet.
   */
  liveStepsByRunNode?: Record<number, WorkflowRunStep[]>;
  /** True while the SSE stream is still flowing. Updates the "Currently executing" pill. */
  isLive: boolean;
  /** Node id currently being executed (live only). */
  activeNodeId: string | null;
  activeNodeSince: number | null;
  /** Highlighted node (graph selection) — expand in the timeline for focus. */
  selectedNodeId?: string | null;
}

/**
 * Isolated "currently executing" pill. Its own 500 ms interval lives in
 * this leaf so the parent tree (node groups, step cards, log panes) doesn't
 * re-render every tick just to bump the elapsed-time counter.
 */
function ActiveNodePill({
  activeNodeId,
  activeNodeSince,
}: {
  activeNodeId: string;
  activeNodeSince: number | null;
}) {
  const [, forceTick] = useState(0);
  useEffect(() => {
    const i = setInterval(() => forceTick((n) => n + 1), 500);
    return () => clearInterval(i);
  }, []);
  return (
    <div className="wf-timeline__current">
      <span className="wf-timeline__dot" />
      <span>Currently executing:</span>
      <strong>{activeNodeId}</strong>
      <span className="wf-timeline__current-elapsed">
        {elapsed(activeNodeSince)}
      </span>
    </div>
  );
}

function fmtDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}

function elapsed(since: number | null): string {
  if (since == null) return "";
  return fmtDuration(Date.now() - since);
}

export default function WorkflowRunTimeline({
  run,
  nodes,
  liveStepsByRunNode,
  isLive,
  activeNodeId,
  activeNodeSince,
  selectedNodeId,
}: Props) {
  const grouped = useMemo(() => groupByNodeId(nodes), [nodes]);

  return (
    <div className="wf-timeline">
      <header className="wf-timeline__head">
        {isLive && activeNodeId ? (
          <ActiveNodePill
            activeNodeId={activeNodeId}
            activeNodeSince={activeNodeSince}
          />
        ) : (
          <div className="wf-timeline__current wf-timeline__current--idle">
            {run.status === "done" && <><CheckCircle size={14} /> Finished</>}
            {run.status === "error" && (
              <>
                <AlertCircle size={14} />
                Failed{run.error ? ` — ${run.error}` : ""}
              </>
            )}
            {run.status === "cancelled" && <>Cancelled</>}
            {run.status === "running" && <>Waiting for output…</>}
          </div>
        )}
      </header>
      <div className="wf-timeline__body">
        {grouped.map((g) => (
          <NodeGroup
            key={g.nodeId}
            group={g}
            defaultOpen={
              selectedNodeId === g.nodeId ||
              (isLive && activeNodeId === g.nodeId)
            }
            activeNodeId={isLive ? activeNodeId : null}
            liveStepsByRunNode={liveStepsByRunNode}
          />
        ))}
      </div>
    </div>
  );
}

interface NodeGroup {
  nodeId: string;
  kind: string;
  iterations: WorkflowRunNodeDto[];
}

function groupByNodeId(nodes: WorkflowRunNodeDto[]): NodeGroup[] {
  const byId = new Map<string, NodeGroup>();
  for (const n of nodes) {
    let g = byId.get(n.nodeId);
    if (!g) {
      g = { nodeId: n.nodeId, kind: n.kind, iterations: [] };
      byId.set(n.nodeId, g);
    }
    g.iterations.push(n);
  }
  // Preserve execution order by first-seen.
  const seen: NodeGroup[] = [];
  const emitted = new Set<string>();
  for (const n of nodes) {
    if (emitted.has(n.nodeId)) continue;
    const g = byId.get(n.nodeId)!;
    // Order iterations ascending.
    g.iterations.sort((a, b) => a.iteration - b.iteration || a.id - b.id);
    seen.push(g);
    emitted.add(n.nodeId);
  }
  return seen;
}

function KindIcon({ kind, size = 14 }: { kind: string; size?: number }) {
  if (kind === "bash") return <Terminal size={size} />;
  if (kind === "loop") return <RotateCcw size={size} />;
  if (kind === "interactive") return <User size={size} />;
  return <MessageSquareMore size={size} />;
}

function StatusBadge({ status }: { status: WorkflowRunNodeDto["status"] }) {
  if (status === "running") return <Loader2 size={12} className="spin" />;
  if (status === "done") return <CheckCircle size={12} />;
  if (status === "error") return <AlertCircle size={12} />;
  return null;
}

function NodeGroup({
  group,
  defaultOpen,
  activeNodeId,
  liveStepsByRunNode,
}: {
  group: NodeGroup;
  defaultOpen: boolean;
  activeNodeId: string | null;
  liveStepsByRunNode?: Record<number, WorkflowRunStep[]>;
}) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);

  const last = group.iterations[group.iterations.length - 1]!;
  const totalMs = group.iterations.reduce(
    (acc, n) =>
      acc + (n.finishedAt && n.startedAt ? n.finishedAt - n.startedAt : 0),
    0,
  );
  const isActive = activeNodeId === group.nodeId;

  return (
    <section className={`wf-timeline__group ${isActive ? "wf-timeline__group--active" : ""}`}>
      <button
        type="button"
        className="wf-timeline__group-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="wf-timeline__caret">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <KindIcon kind={group.kind} />
        <span className="wf-timeline__node-id">{group.nodeId}</span>
        <span className="wf-timeline__kind-tag">{group.kind.toUpperCase()}</span>
        <span className="wf-timeline__group-status"><StatusBadge status={last.status} /> {last.status}</span>
        {group.iterations.length > 1 ? (
          <span className="wf-timeline__iters">{group.iterations.length}× iters</span>
        ) : null}
        <span className="wf-timeline__group-duration">{fmtDuration(totalMs)}</span>
      </button>
      {open ? (
        <div className="wf-timeline__group-body">
          {group.iterations.map((iter) => (
            <IterationBlock
              key={iter.id}
              node={iter}
              showHeader={group.iterations.length > 1}
              liveSteps={liveStepsByRunNode?.[iter.id]}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function IterationBlock({
  node,
  showHeader,
  liveSteps,
}: {
  node: WorkflowRunNodeDto;
  showHeader: boolean;
  liveSteps?: WorkflowRunStep[];
}) {
  // While the node is running, `steps_json` is not persisted yet — fall
  // back to the live step list built from SSE events. Once finished, the
  // persisted steps win.
  const steps = node.steps.length > 0 ? node.steps : (liveSteps ?? []);
  return (
    <div className="wf-timeline__iter">
      {showHeader ? (
        <div className="wf-timeline__iter-head">
          <span>Iteration {node.iteration}</span>
          <span className="wf-timeline__iter-dur">
            {fmtDuration(
              node.finishedAt && node.startedAt
                ? node.finishedAt - node.startedAt
                : undefined,
            )}
          </span>
        </div>
      ) : null}
      {node.error ? (
        <div className="wf-timeline__error">{node.error}</div>
      ) : null}
      {steps.length === 0 && node.status === "running" ? (
        <div className="wf-timeline__placeholder">
          <Loader2 size={12} className="spin" /> running…
        </div>
      ) : null}
      {steps.length === 0 && node.status !== "running" && node.resultText ? (
        <StepCard
          step={{
            kind: "text",
            label: "content",
            output: node.resultText,
            startedAt: node.startedAt ?? 0,
            durationMs:
              node.finishedAt && node.startedAt
                ? node.finishedAt - node.startedAt
                : undefined,
          }}
        />
      ) : null}
      {steps.map((s, i) => (
        <StepCard key={i} step={s} />
      ))}
    </div>
  );
}

function StepCard({ step }: { step: WorkflowRunStep }) {
  const [open, setOpen] = useState(false);
  const preview = useMemo(
    () => firstLine(step.output ?? step.summary ?? "", 140),
    [step.output, step.summary],
  );
  const icon =
    step.kind === "tool" ? (
      <span className="wf-step__glyph wf-step__glyph--tool">&gt;_</span>
    ) : step.kind === "bash" ? (
      <Terminal size={12} />
    ) : step.label === "reasoning" ? (
      <MessageSquareMore size={12} />
    ) : (
      <span className="wf-step__glyph">—</span>
    );
  const label =
    step.kind === "tool"
      ? step.label ?? "tool"
      : step.kind === "bash"
        ? "Bash"
        : step.label === "reasoning"
          ? "Reasoning"
          : "Content";
  // Card = a div (not a <button>) so the expanded body can host its own
  // scrollbar and the user can select text inside without re-triggering
  // the collapse toggle. Only the header row is clickable.
  return (
    <div
      className={`wf-step ${open ? "wf-step--open" : ""} ${step.ok === false ? "wf-step--error" : ""}`}
    >
      <button
        type="button"
        className="wf-step__head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="wf-step__icon">{icon}</span>
        <span className="wf-step__label">{label}</span>
        <span className="wf-step__preview">{preview}</span>
        <span className="wf-step__duration">{fmtDuration(step.durationMs)}</span>
      </button>
      {open ? (
        <pre className="wf-step__body">
          {step.kind === "tool" && step.summary ? (
            <>
              <strong>args:</strong> {step.summary}
              {"\n\n"}
            </>
          ) : null}
          {step.output ?? step.error ?? ""}
        </pre>
      ) : null}
    </div>
  );
}

function firstLine(s: string, cap: number): string {
  if (!s) return "";
  const nl = s.indexOf("\n");
  const line = nl >= 0 ? s.slice(0, nl) : s;
  return line.length > cap ? line.slice(0, cap) + "…" : line;
}
