import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AuthUser } from "../../api";
import {
  getWorkflow,
  listWorkflowRuns,
  startWorkflowRun,
  updateWorkflow,
  type WorkflowDto,
  type WorkflowRunDto,
} from "../../api";
import {
  computeOwnerOf,
  parseClientWorkflow,
  serializeClientWorkflow,
  type ClientWorkflowDef,
  type NodeKind,
} from "../../lib/workflowParser";
import WorkflowGraphView, {
  autoLayout,
  type GraphLayout,
} from "./WorkflowGraphView";
import NodeToolbox, { defaultNodeForKind, nextNodeId } from "./NodeToolbox";
import NodeEditDrawer from "./NodeEditDrawer";
import WorkflowRunView from "./WorkflowRunView";
import { ICON_DEFAULTS, Play, Clock } from "../../lib/icons";

interface Props {
  workflowId: number;
  project: string;
  currentUser: AuthUser;
  onDeleted: () => void;
}

type View = "graph" | "toml" | "runs";

const SAVE_DEBOUNCE_MS = 500;

function parseLayoutJson(raw: string | null): GraphLayout {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: GraphLayout = {};
    for (const [id, pos] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        pos &&
        typeof pos === "object" &&
        "x" in pos &&
        "y" in pos &&
        typeof (pos as { x: unknown }).x === "number" &&
        typeof (pos as { y: unknown }).y === "number"
      ) {
        out[id] = {
          x: (pos as { x: number }).x,
          y: (pos as { y: number }).y,
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}

export default function WorkflowEditor({ workflowId, project }: Props) {
  const [workflow, setWorkflow] = useState<WorkflowDto | null>(null);
  const [tomlText, setTomlText] = useState<string>("");
  const [savedTomlText, setSavedTomlText] = useState<string>("");
  const [layout, setLayout] = useState<GraphLayout>({});
  const [savedLayout, setSavedLayout] = useState<GraphLayout>({});
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [view, setView] = useState<View>(() => {
    const raw = localStorage.getItem(`bunny.workflowEditor.view.${workflowId}`);
    return raw === "graph" || raw === "toml" || raw === "runs" ? raw : "graph";
  });
  const [runs, setRuns] = useState<WorkflowRunDto[] | null>(null);
  const [activeRunId, setActiveRunId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [running, setRunning] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    void (async () => {
      try {
        const data = await getWorkflow(workflowId);
        if (cancelled) return;
        setWorkflow(data.workflow);
        setTomlText(data.tomlText ?? "");
        setSavedTomlText(data.tomlText ?? "");
        const persisted = parseLayoutJson(data.workflow.layoutJson);
        setLayout(persisted);
        setSavedLayout(persisted);
        setSelectedNodeId(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workflowId]);

  useEffect(() => {
    localStorage.setItem(`bunny.workflowEditor.view.${workflowId}`, view);
    if (view === "runs" && runs === null) {
      void listWorkflowRuns(workflowId).then(setRuns).catch(() => setRuns([]));
    }
  }, [view, workflowId, runs]);

  const parsed = useMemo(() => parseClientWorkflow(tomlText), [tomlText]);

  // Ensure the layout map covers every node — new nodes get a dagre-derived
  // initial position. Computed but not saved until the user commits an edit.
  const effectiveLayout = useMemo(() => {
    if (!parsed.def) return layout;
    const missing = parsed.def.nodes.some((n) => !(n.id in layout));
    if (!missing) return layout;
    const fallback = autoLayout(parsed.def);
    return { ...fallback, ...layout };
  }, [parsed.def, layout]);

  // Debounced autosave (TOML + layout in the same PUT call).
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!workflow) return;
    const tomlDirty = tomlText !== savedTomlText;
    const layoutDirty = JSON.stringify(layout) !== JSON.stringify(savedLayout);
    if (!tomlDirty && !layoutDirty) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      setSaveStatus("saving");
      try {
        const body: Parameters<typeof updateWorkflow>[1] = {};
        if (tomlDirty) body.tomlText = tomlText;
        if (layoutDirty) body.layout = layout;
        const res = await updateWorkflow(workflowId, body);
        setWorkflow(res.workflow);
        setSavedTomlText(res.tomlText ?? tomlText);
        setSavedLayout(parseLayoutJson(res.workflow.layoutJson));
        setSaveStatus("saved");
      } catch (e) {
        setSaveStatus("error");
        setError(e instanceof Error ? e.message : String(e));
      }
    }, SAVE_DEBOUNCE_MS);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [tomlText, savedTomlText, layout, savedLayout, workflow, workflowId]);

  const commitDefChange = useCallback(
    (next: ClientWorkflowDef) => {
      setTomlText(serializeClientWorkflow(next));
    },
    [],
  );

  const onLayoutChange = useCallback((next: GraphLayout) => {
    setLayout(next);
  }, []);

  const onAddNode = useCallback(
    (kind: NodeKind) => {
      const def = parsed.def ?? {
        name: "workflow",
        nodes: [] as ClientWorkflowDef["nodes"],
      };
      const id = nextNodeId(def.nodes, kind);
      const node = defaultNodeForKind(kind, id);
      // Place the new node below any existing one so it doesn't overlap.
      const maxY = Object.values(effectiveLayout).reduce(
        (acc, p) => Math.max(acc, p.y),
        -Infinity,
      );
      const initialPos =
        maxY === -Infinity ? { x: 0, y: 0 } : { x: 0, y: maxY + 120 };
      setLayout((prev) => ({ ...prev, [id]: initialPos }));
      commitDefChange({ ...def, nodes: [...def.nodes, node] });
      setSelectedNodeId(id);
    },
    [parsed.def, effectiveLayout, commitDefChange],
  );

  const onAddAtPosition = useCallback(
    (kind: NodeKind, x: number, y: number) => {
      const def = parsed.def ?? {
        name: "workflow",
        nodes: [] as ClientWorkflowDef["nodes"],
      };
      const id = nextNodeId(def.nodes, kind);
      const node = defaultNodeForKind(kind, id);
      setLayout((prev) => ({ ...prev, [id]: { x, y } }));
      commitDefChange({ ...def, nodes: [...def.nodes, node] });
      setSelectedNodeId(id);
    },
    [parsed.def, commitDefChange],
  );

  const ownerOfNode = useMemo(
    () => (parsed.def ? computeOwnerOf(parsed.def) : {}),
    [parsed.def],
  );

  const onDeleteNode = useCallback(
    (nodeId: string) => {
      if (!parsed.def) return;
      const keep = parsed.def.nodes.filter((n) => n.id !== nodeId);
      commitDefChange({
        ...parsed.def,
        nodes: keep.map((n) => ({
          ...n,
          depends_on: n.depends_on.filter((d) => d !== nodeId),
        })),
      });
      setLayout((prev) => {
        const next = { ...prev };
        delete next[nodeId];
        return next;
      });
      if (selectedNodeId === nodeId) setSelectedNodeId(null);
    },
    [parsed.def, commitDefChange, selectedNodeId],
  );

  const onRun = useCallback(async () => {
    if (!workflow) return;
    setRunning(true);
    setError(null);
    try {
      const { run } = await startWorkflowRun(workflow.id);
      setActiveRunId(run.id);
      setView("runs");
      const fresh = await listWorkflowRuns(workflow.id);
      setRuns(fresh);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }, [workflow]);

  if (!workflow) {
    return (
      <div className="workflows-tab__placeholder">
        {error ? <div className="error-banner">{error}</div> : "Loading…"}
      </div>
    );
  }

  return (
    <div className="workflow-editor">
      <header className="workflow-editor__head">
        <div>
          <h2 className="workflow-editor__title">{workflow.name}</h2>
          {workflow.description ? (
            <p className="workflow-editor__desc">{workflow.description}</p>
          ) : null}
        </div>
        <div className="workflow-editor__actions">
          <span className="workflow-editor__save">
            {saveStatus === "saving"
              ? "Saving…"
              : saveStatus === "saved"
                ? "Saved"
                : saveStatus === "error"
                  ? "Save failed"
                  : ""}
          </span>
          <button
            type="button"
            className="btn btn--primary"
            onClick={onRun}
            disabled={running || !parsed.def}
            title={parsed.def ? "Run workflow" : "Fix parse errors first"}
          >
            <Play size={14} /> Run
          </button>
        </div>
      </header>

      <nav className="workflow-editor__tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={view === "graph"}
          className={`workflow-editor__tab ${view === "graph" ? "workflow-editor__tab--active" : ""}`}
          onClick={() => setView("graph")}
        >
          Graph
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === "toml"}
          className={`workflow-editor__tab ${view === "toml" ? "workflow-editor__tab--active" : ""}`}
          onClick={() => setView("toml")}
        >
          TOML
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === "runs"}
          className={`workflow-editor__tab ${view === "runs" ? "workflow-editor__tab--active" : ""}`}
          onClick={() => setView("runs")}
        >
          Runs
        </button>
      </nav>

      {error ? <div className="error-banner">{error}</div> : null}
      {parsed.errors.length > 0 ? (
        <div className="error-banner">
          <strong>Workflow errors:</strong>
          <ul style={{ margin: "4px 0 0 16px" }}>
            {parsed.errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="workflow-editor__body">
        {view === "graph" ? (
          <div className="workflow-editor__composer">
            <NodeToolbox onAdd={onAddNode} />
            <div className="workflow-editor__canvas">
              {parsed.def ? (
                <WorkflowGraphView
                  def={parsed.def}
                  layout={effectiveLayout}
                  onDefChange={commitDefChange}
                  onLayoutChange={onLayoutChange}
                  onAddAtPosition={onAddAtPosition}
                  selectedNodeId={selectedNodeId}
                  onSelect={setSelectedNodeId}
                  ownerOfNode={ownerOfNode}
                />
              ) : (
                <div className="workflow-editor__placeholder">
                  Fix the TOML errors to render the graph, or add a node from
                  the toolbox to start over.
                </div>
              )}
            </div>
            {selectedNodeId && parsed.def ? (
              <NodeEditDrawer
                def={parsed.def}
                nodeId={selectedNodeId}
                project={project}
                onClose={() => setSelectedNodeId(null)}
                onChange={commitDefChange}
                onDelete={onDeleteNode}
              />
            ) : null}
          </div>
        ) : view === "toml" ? (
          <textarea
            className="workflow-editor__toml"
            value={tomlText}
            onChange={(e) => setTomlText(e.target.value)}
            spellCheck={false}
          />
        ) : (
          <RunsPane
            workflowId={workflow.id}
            project={project}
            runs={runs}
            activeRunId={activeRunId}
            onPickRun={setActiveRunId}
            onReloadRuns={async () =>
              setRuns(await listWorkflowRuns(workflow.id))
            }
            def={parsed.def ?? null}
            layout={effectiveLayout}
          />
        )}
      </div>
    </div>
  );
}

interface RunsPaneProps {
  workflowId: number;
  project: string;
  runs: WorkflowRunDto[] | null;
  activeRunId: number | null;
  onPickRun: (id: number) => void;
  onReloadRuns: () => Promise<void>;
  def: NonNullable<ReturnType<typeof parseClientWorkflow>["def"]> | null;
  layout: GraphLayout;
}

function RunsPane({
  workflowId,
  runs,
  activeRunId,
  onPickRun,
  onReloadRuns,
  def,
  layout,
}: RunsPaneProps) {
  if (!runs) return <div className="workflow-editor__placeholder">Loading…</div>;
  if (runs.length === 0) {
    return (
      <div className="workflow-editor__placeholder">
        No runs yet — click Run to start one.
      </div>
    );
  }
  return (
    <div className="workflow-runs-pane">
      <aside className="workflow-runs-pane__list">
        {runs.map((r) => (
          <button
            key={r.id}
            type="button"
            className={`workflow-runs-pane__item ${
              r.id === activeRunId ? "workflow-runs-pane__item--active" : ""
            }`}
            onClick={() => onPickRun(r.id)}
          >
            <div className="workflow-runs-pane__row">
              <Clock {...ICON_DEFAULTS} />
              <span>#{r.id}</span>
              <span
                className={`workflow-runs-pane__status workflow-runs-pane__status--${r.status}`}
              >
                {r.status}
              </span>
            </div>
            <div className="workflow-runs-pane__sub">
              {new Date(r.startedAt).toLocaleString()}
            </div>
          </button>
        ))}
      </aside>
      <section className="workflow-runs-pane__view">
        {activeRunId != null ? (
          <WorkflowRunView
            workflowId={workflowId}
            runId={activeRunId}
            def={def}
            layout={layout}
            onRunFinished={onReloadRuns}
          />
        ) : (
          <div className="workflow-editor__placeholder">
            Pick a run on the left to inspect it.
          </div>
        )}
      </section>
    </div>
  );
}
