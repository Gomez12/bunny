import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  fetchCodeGraphData,
  fetchCodeGraphReport,
  fetchCodeProject,
  streamCodeGraph,
  type CodeGraphData,
  type CodeGraphNode,
  type CodeProject,
} from "../../api";
import type { ServerEvent } from "../../api";
import EmptyState from "../../components/EmptyState";
import {
  AlertCircle,
  Loader2,
  Network,
  Play,
  RefreshCw,
} from "../../lib/icons";

const POLL_MS = 2000;
const MAX_STREAM_LOG_CHARS = 8000;
const DEFAULT_DISPLAY_MAX = 150;
const MAX_CLUSTERS_SHOWN = 12;
const NODE_WIDTH = 140;
const NODE_HEIGHT = 32;
const HUB_NODE_WIDTH = 168;
const HUB_NODE_HEIGHT = 40;
const CLUSTER_GAP = 80;
const CLUSTER_INNER_PAD = 28;

function clampLog(text: string): string {
  return text.length > MAX_STREAM_LOG_CHARS
    ? text.slice(text.length - MAX_STREAM_LOG_CHARS)
    : text;
}

interface Props {
  codeProject: CodeProject;
  onChanged: (next: CodeProject) => void;
}

type ViewMode = "graph" | "report";

/**
 * "Graph" feature: runs the Bun-native code-knowledge-graph pipeline
 * against the cloned repo and renders the result with xyflow.
 *
 * Status transitions are driven by polling (2 s) the parent `/api/code/:id`
 * endpoint, the same pattern Show Code uses for clone state. A live log
 * pane mirrors SSE events while a run is in flight.
 */
export default function CodeGraphView({ codeProject, onChanged }: Props) {
  const [log, setLog] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("graph");
  const [graphData, setGraphData] = useState<CodeGraphData | null>(null);
  const [report, setReport] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [showExternals, setShowExternals] = useState(false);

  const abortRef = useRef<(() => void) | null>(null);

  const status = codeProject.graphStatus;
  const isRunning = status === "extracting" || status === "clustering" || status === "rendering";
  const isReady = status === "ready";

  const reloadProject = useCallback(async () => {
    try {
      const fresh = await fetchCodeProject(codeProject.id);
      onChanged(fresh);
      return fresh;
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, [codeProject.id, onChanged]);

  const loadArtefacts = useCallback(async () => {
    try {
      const data = await fetchCodeGraphData(codeProject.id);
      setGraphData(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    try {
      const md = await fetchCodeGraphReport(codeProject.id);
      setReport(md);
    } catch {
      // Report is optional — graph data without a report is still usable.
    }
  }, [codeProject.id]);

  // Poll status while running so the status chip stays in sync without SSE.
  useEffect(() => {
    if (!isRunning) return;
    let cancelled = false;
    const tick = async () => {
      await reloadProject();
      if (!cancelled) setTimeout(tick, POLL_MS);
    };
    const t = setTimeout(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [isRunning, reloadProject]);

  // Load artefacts whenever we land on ready (and on first mount if already ready).
  useEffect(() => {
    if (isReady) void loadArtefacts();
  }, [isReady, loadArtefacts, codeProject.id]);

  const startRun = useCallback(() => {
    if (streaming) return;
    setStreaming(true);
    setLog("");
    setError(null);
    abortRef.current?.();
    const handle = streamCodeGraph(codeProject.id, (ev: ServerEvent) => {
      // ServerEvent has many shapes — narrow loosely on the `type` field.
      const anyEv = ev as { type?: string };
      if (anyEv.type === "code_graph_log") {
        const text = (ev as { text: string }).text;
        setLog((prev) => clampLog(prev + text + "\n"));
      } else if (anyEv.type === "code_graph_phase") {
        const e = ev as {
          phase: string;
          filesDone?: number;
          filesTotal?: number;
        };
        const line =
          e.filesDone !== undefined && e.filesTotal !== undefined
            ? `[phase: ${e.phase}] ${e.filesDone}/${e.filesTotal}`
            : `[phase: ${e.phase}]`;
        setLog((prev) => clampLog(prev + line + "\n"));
      } else if (anyEv.type === "code_graph_run_finished") {
        const e = ev as {
          status: "ready" | "error";
          error?: string;
        };
        setLog((prev) =>
          clampLog(
            prev +
              (e.status === "ready"
                ? `[done] graph ready\n`
                : `[error] ${e.error ?? "unknown"}\n`),
          ),
        );
        setStreaming(false);
        void reloadProject();
      }
    });
    abortRef.current = handle.abort;
    void handle.done.finally(() => {
      setStreaming(false);
      void reloadProject();
    });
  }, [codeProject.id, reloadProject, streaming]);

  useEffect(
    () => () => {
      abortRef.current?.();
    },
    [],
  );

  return (
    <div className="code-graph">
      <header className="code-graph__header">
        <div className="code-graph__title">
          <Network size={16} />
          <span>Knowledge graph</span>
          <StatusChip status={status} nodeCount={codeProject.graphNodeCount} />
        </div>
        <div className="code-graph__actions">
          <button
            type="button"
            className="btn btn--primary"
            onClick={startRun}
            disabled={streaming || isRunning}
            title={
              streaming || isRunning ? "A run is in progress" : "Generate graph"
            }
          >
            {streaming || isRunning ? (
              <>
                <Loader2 size={14} className="code-graph__spinner" /> Generating…
              </>
            ) : isReady ? (
              <>
                <RefreshCw size={14} /> Regenerate
              </>
            ) : (
              <>
                <Play size={14} /> Generate graph
              </>
            )}
          </button>
        </div>
      </header>

      {(streaming || isRunning) && (
        <pre className="code-graph__log" aria-label="graph run log">
          {log || "starting…"}
        </pre>
      )}

      {!streaming && !isRunning && status === "error" && (
        <EmptyState
          title="Graph generation failed"
          description={codeProject.graphError ?? "Unknown error."}
          action={
            <button type="button" className="btn btn--primary" onClick={startRun}>
              Try again
            </button>
          }
        />
      )}

      {!streaming && status === "idle" && (
        <EmptyState
          title="No graph yet"
          description="Generate a knowledge graph of this repo to see modules, imports, classes, and functions clustered by topic."
          action={
            <button type="button" className="btn btn--primary" onClick={startRun}>
              Generate graph
            </button>
          }
        />
      )}

      {isReady && graphData && (
        <>
          <div className="code-graph__tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === "graph"}
              className={`tab ${viewMode === "graph" ? "tab--active" : ""}`}
              onClick={() => setViewMode("graph")}
            >
              Graph
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === "report"}
              className={`tab ${viewMode === "report" ? "tab--active" : ""}`}
              onClick={() => setViewMode("report")}
            >
              Report
            </button>
            {viewMode === "graph" && (
              <label className="code-graph__toggle">
                <input
                  type="checkbox"
                  checked={showExternals}
                  onChange={(e) => setShowExternals(e.target.checked)}
                />
                Show external imports
              </label>
            )}
          </div>
          {viewMode === "graph" ? (
            <GraphCanvas data={graphData} showExternals={showExternals} />
          ) : (
            <article className="code-graph__report markdown-body">
              {report ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{report}</ReactMarkdown>
              ) : (
                <p className="muted">Report not available.</p>
              )}
            </article>
          )}
        </>
      )}

      {error && (
        <div className="project-form__hint project-form__hint--error">
          <AlertCircle size={14} /> {error}
        </div>
      )}
      {fetchError && (
        <div className="project-form__hint project-form__hint--error">
          {fetchError}
        </div>
      )}
    </div>
  );
}

// ── Status chip ──────────────────────────────────────────────────────────────

function StatusChip({
  status,
  nodeCount,
}: {
  status: CodeProject["graphStatus"];
  nodeCount: number | null;
}) {
  let label: string = status;
  if (status === "ready" && nodeCount != null) label = `${nodeCount} nodes`;
  return <span className={`code-graph__chip code-graph__chip--${status}`}>{label}</span>;
}

// ── Graph canvas ─────────────────────────────────────────────────────────────

interface CanvasProps {
  data: CodeGraphData;
  /** When false, `external:*` nodes are dropped from the displayed graph. */
  showExternals: boolean;
}

function GraphCanvas({ data, showExternals }: CanvasProps) {
  const { nodes, edges, kept, total, clusterCount } = useMemo(() => {
    const filtered = filterNodes(data, showExternals);
    const hubSet = computeHubs(filtered);
    const grouped = groupByTopClusters(filtered, hubSet);
    const layout = layoutClusterGrid(grouped, hubSet);
    const lookup = new Map(filtered.nodes.map((n) => [n.id, n]));

    const rfNodes: Node[] = [];
    for (const cluster of grouped) {
      for (const id of cluster.members) {
        const n = lookup.get(id);
        if (!n) continue;
        const isHub = hubSet.has(id);
        const colour = clusterColour(cluster.id);
        const pos = layout[id] ?? { x: 0, y: 0 };
        rfNodes.push({
          id,
          position: pos,
          data: { label: shortLabel(n), kind: n.kind, isHub },
          style: {
            width: isHub ? HUB_NODE_WIDTH : NODE_WIDTH,
            height: isHub ? HUB_NODE_HEIGHT : NODE_HEIGHT,
            background: colour.bg,
            border: `${isHub ? 2 : 1}px solid ${colour.border}`,
            color: colour.fg,
            borderRadius: 6,
            padding: "2px 8px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            textAlign: "center",
            fontSize: isHub ? 12 : 11,
            fontWeight: isHub ? 600 : 500,
            overflow: "hidden",
            whiteSpace: "nowrap",
            textOverflow: "ellipsis",
          },
        });
      }
    }

    const keptIds = new Set(rfNodes.map((n) => n.id));
    const rfEdges: Edge[] = [];
    for (const e of filtered.edges) {
      if (!keptIds.has(e.from) || !keptIds.has(e.to)) continue;
      const fromNode = lookup.get(e.from);
      const toNode = lookup.get(e.to);
      const crossCluster =
        fromNode &&
        toNode &&
        fromNode.cluster !== undefined &&
        toNode.cluster !== undefined &&
        fromNode.cluster !== toNode.cluster;
      rfEdges.push({
        id: `${e.from}->${e.to}->${e.kind}`,
        source: e.from,
        target: e.to,
        label: e.kind === "imports" ? undefined : e.kind,
        style: {
          stroke: crossCluster
            ? "rgba(80,80,90,0.55)"
            : "rgba(120,120,130,0.28)",
          strokeWidth: crossCluster ? 1.4 : 0.9,
        },
      });
    }

    return {
      nodes: rfNodes,
      edges: rfEdges,
      kept: keptIds.size,
      total: filtered.nodes.length,
      clusterCount: grouped.length,
    };
  }, [data, showExternals]);

  const truncated = kept < total;

  return (
    <div className="code-graph__canvas">
      <div className="code-graph__notice">
        {truncated
          ? `Showing ${kept} of ${total} nodes across the top ${clusterCount} clusters.`
          : `Showing all ${kept} nodes across ${clusterCount} clusters.`}
        {!showExternals && data.nodes.some((n) => n.id.startsWith("external:"))
          ? " External imports hidden — toggle to include."
          : null}
      </div>
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          fitView
          fitViewOptions={{ padding: 0.15 }}
          minZoom={0.05}
          maxZoom={2}
          nodesDraggable={false}
          nodesConnectable={false}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={20} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}

// ── Selection + layout ───────────────────────────────────────────────────────

interface ClusterGroup {
  /** Original cluster id; `-1` for unclustered. */
  id: number;
  members: string[];
}

/** Optionally drop synthetic `external:*` nodes (and their incident edges). */
function filterNodes(
  data: CodeGraphData,
  showExternals: boolean,
): CodeGraphData {
  if (showExternals) return data;
  const keep = new Set<string>();
  const filteredNodes: CodeGraphNode[] = [];
  for (const n of data.nodes) {
    if (n.id.startsWith("external:")) continue;
    keep.add(n.id);
    filteredNodes.push(n);
  }
  const filteredEdges = data.edges.filter(
    (e) => keep.has(e.from) && keep.has(e.to),
  );
  return {
    ...data,
    nodes: filteredNodes,
    edges: filteredEdges,
  };
}

/** Recompute top-degree hubs over the filtered graph. The persisted god/bridge
 *  lists were computed on the full graph and are dominated by externals. */
function computeHubs(data: CodeGraphData): Set<string> {
  const degree = degreeMap(data);
  const ranked = [...degree.entries()].sort(([, a], [, b]) => b - a);
  const top = ranked.slice(0, 16).map(([id]) => id);
  return new Set(top);
}

function degreeMap(data: CodeGraphData): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of data.edges) {
    out.set(e.from, (out.get(e.from) ?? 0) + 1);
    out.set(e.to, (out.get(e.to) ?? 0) + 1);
  }
  for (const n of data.nodes) if (!out.has(n.id)) out.set(n.id, 0);
  return out;
}

/** Pick the top N clusters by size, then within each cluster pick the
 *  highest-degree members up to a per-cluster budget. Hubs always stay. */
function groupByTopClusters(
  data: CodeGraphData,
  hubSet: Set<string>,
): ClusterGroup[] {
  const degree = degreeMap(data);
  const byCluster = new Map<number, string[]>();
  for (const n of data.nodes) {
    const c = n.cluster ?? -1;
    const list = byCluster.get(c) ?? [];
    list.push(n.id);
    byCluster.set(c, list);
  }

  const sorted = [...byCluster.entries()].sort(
    ([, a], [, b]) => b.length - a.length,
  );
  const top = sorted.slice(0, MAX_CLUSTERS_SHOWN);
  const totalKept = top.reduce((sum, [, ids]) => sum + ids.length, 0);
  if (totalKept === 0) return [];

  const groups: ClusterGroup[] = [];
  let usedBudget = hubSet.size;
  const cap = DEFAULT_DISPLAY_MAX;

  for (const [id, ids] of top) {
    const proportional = Math.round((ids.length / totalKept) * cap);
    const want = Math.max(2, Math.min(proportional, ids.length));
    const ranked = [...ids].sort(
      (a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0),
    );
    const members: string[] = [];
    for (const nid of ranked) {
      if (members.length >= want) break;
      members.push(nid);
    }
    // Make sure any hub from this cluster is in.
    for (const nid of ids) {
      if (hubSet.has(nid) && !members.includes(nid)) members.push(nid);
    }
    usedBudget += members.length;
    groups.push({ id, members });
    if (usedBudget >= cap * 1.2) break;
  }
  return groups;
}

/**
 * Pack each cluster as a circle (hub at the centre) and tile the cluster
 * circles in a √N grid. Predictable and stable — no force simulation.
 */
function layoutClusterGrid(
  groups: ClusterGroup[],
  hubSet: Set<string>,
): Record<string, { x: number; y: number }> {
  const out: Record<string, { x: number; y: number }> = {};
  if (groups.length === 0) return out;

  const cols = Math.ceil(Math.sqrt(groups.length));
  // Per-cluster diameter scales with √members so a 50-node cluster doesn't
  // dwarf a 4-node one.
  const cellSizes = groups.map((g) => clusterDiameter(g.members.length));
  const maxCell = Math.max(...cellSizes);

  groups.forEach((group, idx) => {
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    const cellW = maxCell + CLUSTER_GAP;
    const cellH = maxCell + CLUSTER_GAP;
    const cx = col * cellW + cellW / 2;
    const cy = row * cellH + cellH / 2;

    const members = group.members;
    const hubInCluster = members.find((id) => hubSet.has(id));
    const ring = hubInCluster
      ? members.filter((id) => id !== hubInCluster)
      : members;
    const radius =
      Math.max(60, clusterDiameter(members.length) / 2 - CLUSTER_INNER_PAD);

    if (hubInCluster) {
      out[hubInCluster] = {
        x: cx - HUB_NODE_WIDTH / 2,
        y: cy - HUB_NODE_HEIGHT / 2,
      };
    }
    if (ring.length === 1 && !hubInCluster) {
      out[ring[0]!] = { x: cx - NODE_WIDTH / 2, y: cy - NODE_HEIGHT / 2 };
      return;
    }
    ring.forEach((id, i) => {
      const angle = (i / ring.length) * Math.PI * 2 - Math.PI / 2;
      const x = cx + Math.cos(angle) * radius - NODE_WIDTH / 2;
      const y = cy + Math.sin(angle) * radius - NODE_HEIGHT / 2;
      out[id] = { x, y };
    });
  });

  return out;
}

function clusterDiameter(memberCount: number): number {
  // Floor of 240 keeps tiny clusters legible; sqrt growth keeps big clusters
  // from blowing past the viewport.
  return Math.max(240, 90 + Math.sqrt(memberCount) * 70);
}

function shortLabel(n: CodeGraphNode): string {
  if (n.id.startsWith("external:")) return `📦 ${n.name}`;
  // For module nodes, show the basename instead of the full path.
  if (n.kind === "module" && n.name.includes("/")) {
    const parts = n.name.split("/");
    return parts[parts.length - 1] ?? n.name;
  }
  return n.name;
}

const CLUSTER_PALETTE = [
  { bg: "#e0f2fe", border: "#38bdf8", fg: "#075985" },
  { bg: "#fef3c7", border: "#f59e0b", fg: "#92400e" },
  { bg: "#dcfce7", border: "#22c55e", fg: "#14532d" },
  { bg: "#ede9fe", border: "#8b5cf6", fg: "#4c1d95" },
  { bg: "#ffe4e6", border: "#f43f5e", fg: "#881337" },
  { bg: "#e0e7ff", border: "#6366f1", fg: "#312e81" },
  { bg: "#f3e8ff", border: "#a855f7", fg: "#581c87" },
  { bg: "#fdf4ff", border: "#d946ef", fg: "#701a75" },
  { bg: "#fff7ed", border: "#fb923c", fg: "#7c2d12" },
  { bg: "#ecfeff", border: "#06b6d4", fg: "#155e75" },
  { bg: "#f7fee7", border: "#84cc16", fg: "#3f6212" },
  { bg: "#fef2f2", border: "#fca5a5", fg: "#7f1d1d" },
];

function clusterColour(cluster: number): {
  bg: string;
  border: string;
  fg: string;
} {
  if (cluster < 0) return { bg: "#f3f4f6", border: "#cbd5e1", fg: "#1f2937" };
  return CLUSTER_PALETTE[cluster % CLUSTER_PALETTE.length]!;
}
