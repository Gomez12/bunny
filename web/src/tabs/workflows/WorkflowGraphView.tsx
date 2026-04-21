import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MarkerType,
  Handle,
  Position,
  type Edge,
  type Node,
  type NodeChange,
  type EdgeChange,
  type Connection,
  type OnConnect,
  type OnNodesChange,
  type OnEdgesChange,
  type ReactFlowInstance,
  applyNodeChanges,
  applyEdgeChanges,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "dagre";
import type { ClientWorkflowDef, NodeKind } from "../../lib/workflowParser";
import { Trash2 } from "../../lib/icons";

/**
 * Editable + read-only workflow graph.
 *
 * - `readOnly = true` disables drag, connect, and node deletion. Used by
 *   the Run view.
 * - In edit mode the component emits `onDefChange` after any structural
 *   edit (add / remove node, add / remove edge) and `onLayoutChange`
 *   after a drag. The parent persists both (TOML for def, `layout_json`
 *   for positions) on a debounced save.
 * - Nodes for which `layout[id]` is unset are auto-laid out via dagre
 *   once; once a node has been moved, its position sticks.
 */
export interface GraphLayout {
  [nodeId: string]: { x: number; y: number };
}

interface Props {
  def: ClientWorkflowDef;
  layout: GraphLayout;
  readOnly?: boolean;
  onDefChange?: (next: ClientWorkflowDef) => void;
  onLayoutChange?: (next: GraphLayout) => void;
  /**
   * Called when the user drops a toolbox item on the canvas. The graph
   * view hands back the flow-space (x, y) coordinates; the parent mints a
   * fresh node id and inserts the node.
   */
  onAddAtPosition?: (kind: NodeKind, x: number, y: number) => void;
  /** Optional per-node status map (run view). */
  statusByNodeId?: Record<string, string>;
  selectedNodeId?: string | null;
  onSelect?: (id: string | null) => void;
  /**
   * Map of body-owned node ids → owner id. Owned nodes are visually muted
   * on the canvas with an "inside: <owner>" chip so it's clear they only
   * execute inside their owner's iteration / branch.
   */
  ownerOfNode?: Record<string, string>;
}

const NODE_WIDTH = 220;
const NODE_HEIGHT = 72;

function autoLayout(def: ClientWorkflowDef): GraphLayout {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", ranksep: 56, nodesep: 28 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of def.nodes) {
    g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const n of def.nodes) {
    for (const dep of n.depends_on) g.setEdge(dep, n.id);
  }
  dagre.layout(g);
  const out: GraphLayout = {};
  for (const n of def.nodes) {
    const p = g.node(n.id);
    if (p) out[n.id] = { x: p.x - NODE_WIDTH / 2, y: p.y - NODE_HEIGHT / 2 };
  }
  return out;
}

function buildGraph(
  def: ClientWorkflowDef,
  layout: GraphLayout,
  fallback: GraphLayout,
  opts: {
    statusByNodeId?: Record<string, string>;
    selectedNodeId?: string | null;
    draggable: boolean;
    ownerOfNode?: Record<string, string>;
  },
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = def.nodes.map((n) => {
    const pos = layout[n.id] ?? fallback[n.id] ?? { x: 0, y: 0 };
    const status = opts.statusByNodeId?.[n.id];
    const owner = opts.ownerOfNode?.[n.id];
    const isSelected = opts.selectedNodeId === n.id;
    return {
      id: n.id,
      position: pos,
      data: {
        renderedLabel: n.id,
        kind: n.kind,
        status,
        owner: owner ?? null,
      },
      draggable: opts.draggable,
      selectable: true,
      style: { width: NODE_WIDTH, height: NODE_HEIGHT },
      className: [
        "wf-node",
        `wf-node--${n.kind}`,
        status ? `wf-node--status-${status}` : "",
        isSelected ? "wf-node--selected" : "",
        owner ? "wf-node--owned" : "",
      ]
        .filter(Boolean)
        .join(" "),
    };
  });
  const edges: Edge[] = [];
  for (const n of def.nodes) {
    for (const dep of n.depends_on) {
      edges.push({
        id: `${dep}->${n.id}`,
        source: dep,
        target: n.id,
        markerEnd: { type: MarkerType.ArrowClosed },
      });
    }
  }
  return { nodes, edges };
}

/** Kahn's algorithm — true if adding `source → target` would create a cycle. */
function wouldIntroduceCycle(
  def: ClientWorkflowDef,
  source: string,
  target: string,
): boolean {
  if (source === target) return true;
  // Follow existing depends_on chains from `source` upward; if `target` is
  // in its ancestor closure, the new edge closes a loop.
  const adjByChild = new Map<string, string[]>();
  for (const n of def.nodes) adjByChild.set(n.id, [...n.depends_on]);
  const seen = new Set<string>();
  const stack = [source];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === target) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const parent of adjByChild.get(cur) ?? []) stack.push(parent);
  }
  return false;
}

export default function WorkflowGraphView(props: Props) {
  // ReactFlowProvider needs to wrap both ReactFlow AND any sibling that
  // calls `useReactFlow()` (for screenToFlowPosition on the canvas drop).
  return (
    <ReactFlowProvider>
      <GraphInner {...props} />
    </ReactFlowProvider>
  );
}

function GraphInner({
  def,
  layout,
  readOnly = false,
  onDefChange,
  onLayoutChange,
  onAddAtPosition,
  statusByNodeId,
  selectedNodeId,
  onSelect,
  ownerOfNode,
}: Props) {
  // Auto-layout positions for any node that doesn't have an explicit layout
  // entry yet. Recomputed whenever the node set changes.
  const fallback = useMemo(() => autoLayout(def), [def]);

  const { nodes: baseNodes, edges: baseEdges } = useMemo(
    () =>
      buildGraph(def, layout, fallback, {
        statusByNodeId,
        selectedNodeId,
        draggable: !readOnly,
        ownerOfNode,
      }),
    [
      def,
      layout,
      fallback,
      statusByNodeId,
      selectedNodeId,
      readOnly,
      ownerOfNode,
    ],
  );

  // Local mirror so React Flow's drag animation is smooth — we flush
  // committed positions to the parent on drag-stop rather than on every
  // pixel change.
  const [nodes, setNodes] = useState<Node[]>(baseNodes);
  const [edges, setEdges] = useState<Edge[]>(baseEdges);
  const dragPositionsRef = useRef<GraphLayout>({});
  // React Flow instance — captured via `onInit`. Used by the canvas
  // drop handler (screenToFlowPosition) and the auto-fit effect below.
  const [rfInstance, setRfInstance] = useState<ReactFlowInstance | null>(null);

  useEffect(() => {
    setNodes(baseNodes);
  }, [baseNodes]);
  useEffect(() => {
    setEdges(baseEdges);
  }, [baseEdges]);

  // Auto-fit the viewport when a node is *added* so the user always sees
  // the newcomer (both via toolbox click and via drag-drop). Deletions
  // don't trigger a re-fit to avoid jumpy UX when tidying up.
  const prevNodeCountRef = useRef(baseNodes.length);
  useEffect(() => {
    const prev = prevNodeCountRef.current;
    prevNodeCountRef.current = baseNodes.length;
    if (!rfInstance) return;
    if (baseNodes.length > prev) {
      // Defer one frame so React Flow has the new node laid out.
      requestAnimationFrame(() => {
        rfInstance.fitView({ padding: 0.2, duration: 300 });
      });
    }
  }, [baseNodes.length, rfInstance]);

  const onNodesChange = useCallback<OnNodesChange>(
    (changes: NodeChange[]) => {
      setNodes((cur) => applyNodeChanges(changes, cur));
      if (readOnly) return;
      const removed: string[] = [];
      let sawDragStop = false;
      for (const c of changes) {
        if (c.type === "position" && c.position) {
          dragPositionsRef.current[c.id] = {
            x: c.position.x,
            y: c.position.y,
          };
          if (c.dragging === false) sawDragStop = true;
        }
        if (c.type === "remove") removed.push(c.id);
      }
      // Multi-select drags fire one "dragging:false" change per moved node
      // — we want to commit the *accumulated* positions exactly once per
      // drag-stop batch, not once per node (which would leave later nodes'
      // positions unsaved because the ref was already cleared).
      if (sawDragStop && Object.keys(dragPositionsRef.current).length > 0) {
        const next = { ...layout, ...dragPositionsRef.current };
        dragPositionsRef.current = {};
        onLayoutChange?.(next);
      }
      if (removed.length > 0 && onDefChange) {
        const keep = new Set(def.nodes.map((n) => n.id));
        for (const r of removed) keep.delete(r);
        const next: ClientWorkflowDef = {
          ...def,
          nodes: def.nodes
            .filter((n) => keep.has(n.id))
            .map((n) => ({
              ...n,
              depends_on: n.depends_on.filter((d) => keep.has(d)),
            })),
        };
        onDefChange(next);
      }
    },
    [readOnly, layout, onLayoutChange, onDefChange, def],
  );

  const onEdgesChange = useCallback<OnEdgesChange>(
    (changes: EdgeChange[]) => {
      setEdges((cur) => applyEdgeChanges(changes, cur));
      if (readOnly) return;
      const removed = changes
        .filter((c): c is { type: "remove"; id: string } => c.type === "remove")
        .map((c) => c.id);
      if (removed.length > 0 && onDefChange) {
        const next: ClientWorkflowDef = {
          ...def,
          nodes: def.nodes.map((n) => {
            const keep = n.depends_on.filter(
              (dep) => !removed.includes(`${dep}->${n.id}`),
            );
            return keep.length === n.depends_on.length
              ? n
              : { ...n, depends_on: keep };
          }),
        };
        onDefChange(next);
      }
    },
    [readOnly, def, onDefChange],
  );

  const onConnect = useCallback<OnConnect>(
    (conn: Connection) => {
      if (readOnly) return;
      if (!conn.source || !conn.target || conn.source === conn.target) return;
      if (!onDefChange) return;
      if (wouldIntroduceCycle(def, conn.source, conn.target)) return;
      const next: ClientWorkflowDef = {
        ...def,
        nodes: def.nodes.map((n) => {
          if (n.id !== conn.target) return n;
          if (n.depends_on.includes(conn.source!)) return n;
          return { ...n, depends_on: [...n.depends_on, conn.source!] };
        }),
      };
      onDefChange(next);
    },
    [readOnly, def, onDefChange],
  );

  // Trash drop-zone support: while the user drags a node, we highlight the
  // zone. On drag-stop we check if the cursor is within the trash rect; if
  // so we delete the dragged node (and revert the layout update).
  const [dragActive, setDragActive] = useState(false);
  const [trashHover, setTrashHover] = useState(false);
  const trashRef = useRef<HTMLDivElement | null>(null);

  const isOverTrash = useCallback((clientX: number, clientY: number) => {
    const el = trashRef.current;
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return (
      clientX >= r.left &&
      clientX <= r.right &&
      clientY >= r.top &&
      clientY <= r.bottom
    );
  }, []);

  const onDragOver = useCallback(
    (e: React.DragEvent) => {
      if (readOnly) return;
      // Always preventDefault during a drag so the drop fires. Filtering on
      // the custom MIME type here is unreliable — `dataTransfer.types` is
      // sanitized during dragover by Chromium / Safari for security, and the
      // actual value would come through as empty even when set on dragstart.
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    },
    [readOnly],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      if (readOnly) return;
      const kind = e.dataTransfer.getData("application/bunny-node-kind") as
        | NodeKind
        | "";
      if (!kind) return;
      e.preventDefault();
      if (!rfInstance || !onAddAtPosition) return;
      const pos = rfInstance.screenToFlowPosition({
        x: e.clientX,
        y: e.clientY,
      });
      // Offset so the dropped node's top-left (not center) lands at the cursor.
      onAddAtPosition(kind, pos.x - NODE_WIDTH / 2, pos.y - NODE_HEIGHT / 2);
    },
    [readOnly, rfInstance, onAddAtPosition],
  );

  return (
    <div className="workflow-graph" onDragOver={onDragOver} onDrop={onDrop}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onInit={setRfInstance}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={(_e, n) => onSelect?.(n.id)}
        onPaneClick={() => onSelect?.(null)}
        onNodeDragStart={() => setDragActive(true)}
        onNodeDrag={(ev) => setTrashHover(isOverTrash(ev.clientX, ev.clientY))}
        onNodeDragStop={(ev, primary, dragged) => {
          setDragActive(false);
          setTrashHover(false);
          if (!readOnly && isOverTrash(ev.clientX, ev.clientY) && onDefChange) {
            // React Flow passes the primary node plus the full multi-drag
            // selection as the third arg. When the user shift-selects and
            // drags several nodes onto the trash, delete all of them.
            const trashedIds = new Set<string>(
              (dragged?.length ? dragged : [primary]).map((n) => n.id),
            );
            const keep = def.nodes.filter((n) => !trashedIds.has(n.id));
            onDefChange({
              ...def,
              nodes: keep.map((n) => ({
                ...n,
                depends_on: n.depends_on.filter((d) => !trashedIds.has(d)),
              })),
            });
          }
        }}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        elementsSelectable
        selectNodesOnDrag={false}
        deleteKeyCode={readOnly ? null : ["Delete", "Backspace"]}
        proOptions={{ hideAttribution: true }}
        nodeTypes={NODE_TYPES}
      >
        <Background gap={16} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
      {!readOnly ? (
        <div
          ref={trashRef}
          className={`wf-trash ${dragActive ? "wf-trash--visible" : ""} ${
            trashHover ? "wf-trash--hover" : ""
          }`}
          aria-label="Drop to delete"
          title="Drop a node here to delete it"
        >
          <Trash2 size={18} />
          <span>Drop to delete</span>
        </div>
      ) : null}
    </div>
  );
}

function NodeBox({
  data,
}: {
  data: {
    renderedLabel?: string;
    kind?: string;
    status?: string;
    owner?: string | null;
  };
}) {
  const label = data.renderedLabel ?? "";
  const kind = data.kind ?? "";
  const status = data.status;
  const owner = data.owner ?? null;
  return (
    <>
      <Handle type="target" position={Position.Top} />
      <div className="wf-node__body">
        <div className="wf-node__kind">{kind.replace(/_/g, " ")}</div>
        <div className="wf-node__label">{label}</div>
        {owner ? (
          <div className="wf-node__owner">inside: {owner}</div>
        ) : status ? (
          <div className="wf-node__status">{status}</div>
        ) : null}
      </div>
      <Handle type="source" position={Position.Bottom} />
    </>
  );
}

const NODE_TYPES = {
  default: NodeBox,
} as const;

/** Helper re-exported for callers that want to precompute an initial layout. */
export { autoLayout };
