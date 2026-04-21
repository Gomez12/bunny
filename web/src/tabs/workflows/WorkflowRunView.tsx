import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  answerSessionQuestion,
  cancelWorkflowRun,
  getWorkflowRun,
  streamWorkflowRun,
  type WorkflowRunDto,
  type WorkflowRunNodeDto,
} from "../../api";
import type { ClientWorkflowDef } from "../../lib/workflowParser";
import WorkflowGraphView, {
  autoLayout,
  type GraphLayout,
} from "./WorkflowGraphView";
import WorkflowRunTimeline from "./WorkflowRunTimeline";

interface Props {
  workflowId: number;
  runId: number;
  def: ClientWorkflowDef | null;
  layout: GraphLayout;
  onRunFinished: () => Promise<void>;
}

type NodeStatus = WorkflowRunNodeDto["status"];

interface PendingQuestion {
  questionId: string;
  question: string;
  options: string[];
  allowCustom: boolean;
}

const TIMELINE_WIDTH_KEY = "bunny.workflowRun.timelineWidth";
const TIMELINE_WIDTH_MIN = 280;
const TIMELINE_WIDTH_MAX = 900;
const TIMELINE_WIDTH_DEFAULT = 360;

function readTimelineWidth(): number {
  const raw = Number(localStorage.getItem(TIMELINE_WIDTH_KEY));
  if (!Number.isFinite(raw)) return TIMELINE_WIDTH_DEFAULT;
  return Math.min(TIMELINE_WIDTH_MAX, Math.max(TIMELINE_WIDTH_MIN, raw));
}

export default function WorkflowRunView({
  workflowId: _workflowId,
  runId,
  def,
  layout,
  onRunFinished,
}: Props) {
  const onRunFinishedRef = useRef(onRunFinished);
  useEffect(() => {
    onRunFinishedRef.current = onRunFinished;
  }, [onRunFinished]);
  const [timelineWidth, setTimelineWidth] = useState<number>(() =>
    readTimelineWidth(),
  );
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // Ref so the SSE handler can read the active run-node id without
  // re-subscribing every time it changes.
  const activeRunNodeIdRef = useRef<number | null>(null);

  const [run, setRun] = useState<WorkflowRunDto | null>(null);
  const [nodes, setNodes] = useState<WorkflowRunNodeDto[]>([]);
  const [liveStepsByRunNode, setLiveStepsByRunNode] = useState<
    Record<number, import("../../api").WorkflowRunStep[]>
  >({});
  // Staging buffer for SSE deltas — flushed into `liveStepsByRunNode` once
  // per animation frame so a fast reasoning stream doesn't cause a React
  // re-render storm of the whole right pane.
  const liveBufferRef = useRef<
    Record<number, import("../../api").WorkflowRunStep[]>
  >({});
  const flushRafRef = useRef<number | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  const [activeNodeSince, setActiveNodeSince] = useState<number | null>(null);
  const [pendingQuestion, setPendingQuestion] = useState<PendingQuestion | null>(null);
  const [customAnswer, setCustomAnswer] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const isRunningRef = useRef(false);

  const scheduleFlush = useCallback(() => {
    if (flushRafRef.current !== null) return;
    flushRafRef.current = requestAnimationFrame(() => {
      flushRafRef.current = null;
      const pending = liveBufferRef.current;
      liveBufferRef.current = {};
      setLiveStepsByRunNode((prev) => {
        let next: typeof prev | null = null;
        for (const [rnidStr, extra] of Object.entries(pending)) {
          const rnid = Number(rnidStr);
          const list = prev[rnid] ? [...prev[rnid]!] : [];
          for (const step of extra) {
            const last = list[list.length - 1];
            if (
              step.kind === "text" &&
              last &&
              last.kind === "text" &&
              last.label === step.label
            ) {
              list[list.length - 1] = {
                ...last,
                output: (last.output ?? "") + (step.output ?? ""),
              };
            } else {
              list.push(step);
            }
          }
          next = { ...(next ?? prev), [rnid]: list };
        }
        return next ?? prev;
      });
    });
  }, []);

  useEffect(() => {
    return () => {
      if (flushRafRef.current !== null) cancelAnimationFrame(flushRafRef.current);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setSelectedNodeId(null);
    setActiveNodeId(null);
    activeRunNodeIdRef.current = null;
    setActiveNodeSince(null);
    setLiveStepsByRunNode({});
    liveBufferRef.current = {};
    void (async () => {
      try {
        const data = await getWorkflowRun(runId);
        if (cancelled) return;
        setRun(data.run);
        setNodes(data.nodes);
        sessionIdRef.current = data.run.sessionId;
        isRunningRef.current =
          data.run.status === "running" ||
          data.run.status === "queued" ||
          data.run.status === "paused";
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runId]);

  useEffect(() => {
    if (!run) return;
    if (!isRunningRef.current) return;
    const aborter = streamWorkflowRun(runId, (payload: unknown) => {
      if (!payload || typeof payload !== "object") return;
      const ev = payload as { type: string } & Record<string, unknown>;
      switch (ev.type) {
        case "workflow_node_started": {
          const rnid = Number(ev.runNodeId);
          setActiveNodeId(String(ev.nodeId));
          activeRunNodeIdRef.current = rnid || null;
          setActiveNodeSince(Date.now());
          setNodes((cur) => upsertNodeStatus(cur, ev, "running"));
          break;
        }
        case "workflow_node_finished":
          setActiveNodeId((prev) => (prev === String(ev.nodeId) ? null : prev));
          if (activeRunNodeIdRef.current === Number(ev.runNodeId)) {
            activeRunNodeIdRef.current = null;
          }
          setActiveNodeSince(null);
          setNodes((cur) =>
            upsertNodeStatus(cur, ev, String(ev.status) as NodeStatus),
          );
          break;
        case "tool_result": {
          const rnid = activeRunNodeIdRef.current;
          if (rnid == null) break;
          (liveBufferRef.current[rnid] ??= []).push({
            kind: "tool",
            label: String(ev.name ?? "tool"),
            output: String(ev.output ?? ""),
            ok: ev.ok !== false,
            error: typeof ev.error === "string" ? ev.error : undefined,
            startedAt: Date.now(),
          });
          scheduleFlush();
          break;
        }
        case "content":
        case "reasoning": {
          const rnid = activeRunNodeIdRef.current;
          if (rnid == null) break;
          const text = typeof ev.text === "string" ? ev.text : "";
          if (!text) break;
          (liveBufferRef.current[rnid] ??= []).push({
            kind: "text",
            label: ev.type,
            output: text,
            startedAt: Date.now(),
          });
          scheduleFlush();
          break;
        }
        case "workflow_run_finished":
          isRunningRef.current = false;
          setActiveNodeId(null);
          setActiveNodeSince(null);
          setRun((cur) =>
            cur
              ? {
                  ...cur,
                  status: String(ev.status) as WorkflowRunDto["status"],
                  finishedAt: Date.now(),
                  error:
                    typeof ev.error === "string" ? ev.error : cur.error,
                }
              : cur,
          );
          setPendingQuestion(null);
          // Re-fetch so `steps_json` populated by the engine lands in the UI.
          void (async () => {
            try {
              const fresh = await getWorkflowRun(runId);
              setRun(fresh.run);
              setNodes(fresh.nodes);
            } catch {
              /* keep SSE-derived state */
            }
          })();
          void onRunFinishedRef.current();
          break;
        case "ask_user_question":
          setPendingQuestion({
            questionId: String(ev.questionId),
            question: String(ev.question),
            options: Array.isArray(ev.options)
              ? (ev.options as string[])
              : [],
            allowCustom: ev.allowCustom !== false,
          });
          break;
        case "error":
          setError(String(ev.message ?? "stream error"));
          break;
      }
    });
    return () => aborter.abort();
  }, [run, runId]);

  const statusByNodeId = useMemo(() => {
    const map: Record<string, string> = {};
    // Prefer running/waiting over earlier states so the live pulse wins.
    for (const n of nodes) {
      const prev = map[n.nodeId];
      if (prev === "running" || prev === "waiting") continue;
      map[n.nodeId] = n.status;
    }
    return map;
  }, [nodes]);

  const effectiveLayout = useMemo(() => {
    if (!def) return layout;
    const missing = def.nodes.some((n) => !(n.id in layout));
    if (!missing) return layout;
    return { ...autoLayout(def), ...layout };
  }, [def, layout]);

  const onAnswer = useCallback(
    async (answer: string) => {
      if (!pendingQuestion || !sessionIdRef.current) return;
      const qid = pendingQuestion.questionId;
      setPendingQuestion(null);
      try {
        await answerSessionQuestion(sessionIdRef.current, qid, answer);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [pendingQuestion],
  );

  const onCancel = useCallback(async () => {
    try {
      await cancelWorkflowRun(runId);
      isRunningRef.current = false;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [runId]);

  // Drag-to-resize the right-side timeline. The splitter sits between the
  // graph and the timeline; mousedown starts tracking, mousemove updates
  // the width, mouseup persists to localStorage.
  const onSplitterMouseDown = useCallback(
    (startEv: React.MouseEvent) => {
      startEv.preventDefault();
      const body = bodyRef.current;
      if (!body) return;
      const rect = body.getBoundingClientRect();
      const move = (ev: MouseEvent) => {
        const next = rect.right - ev.clientX;
        const clamped = Math.min(
          TIMELINE_WIDTH_MAX,
          Math.max(TIMELINE_WIDTH_MIN, next),
        );
        setTimelineWidth(clamped);
      };
      const up = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        // Persist — read current state via the ref indirection.
        setTimelineWidth((w) => {
          localStorage.setItem(TIMELINE_WIDTH_KEY, String(Math.round(w)));
          return w;
        });
      };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    },
    [],
  );

  if (!run) {
    return (
      <div className="workflow-editor__placeholder">
        {error ? <div className="error-banner">{error}</div> : "Loading…"}
      </div>
    );
  }

  return (
    <div className="workflow-run">
      <header className="workflow-run__head">
        <div>
          <h3 className="workflow-run__title">Run #{run.id}</h3>
          <span
            className={`workflow-runs-pane__status workflow-runs-pane__status--${run.status}`}
          >
            {run.status}
          </span>
          <span className="workflow-run__when">
            started {new Date(run.startedAt).toLocaleString()}
          </span>
        </div>
        {isRunningRef.current ? (
          <button
            type="button"
            className="btn btn--danger btn--sm"
            onClick={onCancel}
          >
            Cancel
          </button>
        ) : null}
      </header>

      {error ? <div className="error-banner">{error}</div> : null}
      {run.error ? <div className="error-banner">{run.error}</div> : null}

      <div
        ref={bodyRef}
        className="workflow-run__body"
        style={{
          gridTemplateColumns: `1fr 6px ${timelineWidth}px`,
        }}
      >
        <div className="workflow-run__graph">
          {def ? (
            <WorkflowGraphView
              def={def}
              layout={effectiveLayout}
              readOnly
              statusByNodeId={statusByNodeId}
              onSelect={setSelectedNodeId}
              selectedNodeId={selectedNodeId}
            />
          ) : (
            <div className="workflow-editor__placeholder">
              Graph unavailable — fix the TOML parse errors to see node colors.
            </div>
          )}
        </div>
        <div
          className="workflow-run__splitter"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize timeline"
          onMouseDown={onSplitterMouseDown}
          onDoubleClick={() => {
            setTimelineWidth(TIMELINE_WIDTH_DEFAULT);
            localStorage.setItem(
              TIMELINE_WIDTH_KEY,
              String(TIMELINE_WIDTH_DEFAULT),
            );
          }}
        />
        <aside className="workflow-run__timeline">
          <WorkflowRunTimeline
            run={run}
            nodes={nodes}
            liveStepsByRunNode={liveStepsByRunNode}
            isLive={isRunningRef.current}
            activeNodeId={activeNodeId}
            activeNodeSince={activeNodeSince}
            selectedNodeId={selectedNodeId}
          />
        </aside>
      </div>

      {pendingQuestion ? (
        <div className="workflow-run__ask" role="dialog">
          <div className="workflow-run__ask-head">
            <strong>Workflow paused — answer required</strong>
          </div>
          <p>{pendingQuestion.question}</p>
          <div className="workflow-run__ask-options">
            {pendingQuestion.options.map((opt) => (
              <button
                key={opt}
                type="button"
                className="btn btn--primary btn--sm"
                onClick={() => void onAnswer(opt)}
              >
                {opt}
              </button>
            ))}
          </div>
          {pendingQuestion.allowCustom ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (customAnswer.trim()) {
                  void onAnswer(customAnswer.trim());
                  setCustomAnswer("");
                }
              }}
              style={{ display: "flex", gap: 8, marginTop: 8 }}
            >
              <input
                type="text"
                className="input"
                placeholder="Your answer…"
                value={customAnswer}
                onChange={(e) => setCustomAnswer(e.target.value)}
                style={{ flex: 1 }}
              />
              <button type="submit" className="btn">
                Send
              </button>
            </form>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function upsertNodeStatus(
  cur: WorkflowRunNodeDto[],
  ev: Record<string, unknown>,
  status: NodeStatus,
): WorkflowRunNodeDto[] {
  const nid = String(ev.nodeId);
  const iter =
    typeof ev.iteration === "number" ? (ev.iteration as number) : 0;
  const runNodeId =
    typeof ev.runNodeId === "number" ? (ev.runNodeId as number) : 0;
  const match = cur.find(
    (n) => n.runId === Number(ev.runId) && n.id === runNodeId,
  );
  if (match) {
    return cur.map((n) =>
      n.id === match.id
        ? {
            ...n,
            status,
            error:
              typeof ev.error === "string" ? (ev.error as string) : n.error,
            resultText:
              typeof ev.resultText === "string"
                ? (ev.resultText as string)
                : n.resultText,
            finishedAt: status === "running" ? n.finishedAt : Date.now(),
          }
        : n,
    );
  }
  return [
    ...cur,
    {
      id: runNodeId || cur.length + 1,
      runId: Number(ev.runId),
      nodeId: nid,
      kind: String(ev.kind ?? ""),
      status,
      iteration: iter,
      childSessionId: null,
      startedAt: Date.now(),
      finishedAt: null,
      resultText: null,
      logText: null,
      error: null,
      steps: [],
    },
  ];
}
