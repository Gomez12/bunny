import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  type Node,
  type OnNodesChange,
  type OnEdgesChange,
  type OnConnect,
  type ReactFlowInstance,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  MarkerType,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import DiagramNodeComponent, {
  AnchorPointNode,
  type DiagramNodeData,
} from "./DiagramNode";
import type { DiagramLibraryItem } from "../../api";

const NODE_TYPES = {
  diagramNode: DiagramNodeComponent,
  anchorPoint: AnchorPointNode,
} as const;

export interface DiagramContent {
  nodes: Node[];
  edges: Edge[];
}

export interface DiagramCanvasRef {
  getContent(): DiagramContent;
  setContent(content: DiagramContent): void;
  captureThumb(): string | null;
}

interface Props {
  initialContent: DiagramContent;
  readOnly?: boolean;
  onChangeRef?: React.MutableRefObject<((content: DiagramContent) => void) | null>;
  innerRef: React.Ref<DiagramCanvasRef>;
}

interface ContextMenuState {
  x: number;
  y: number;
  targetId: string;
  targetType: "node" | "edge";
}

interface EdgeLabelEdit {
  edgeId: string;
  x: number;
  y: number;
  currentLabel: string;
}

function DiagramCanvasInner({ initialContent, readOnly, onChangeRef, innerRef }: Props) {
  const [nodes, setNodes] = useState<Node[]>(initialContent.nodes);
  const [edges, setEdges] = useState<Edge[]>(initialContent.edges);
  const [rfInstance, setRfInstance] = useState<ReactFlowInstance | null>(null);
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);
  const [edgeLabelEdit, setEdgeLabelEdit] = useState<EdgeLabelEdit | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);

  useEffect(() => { nodesRef.current = nodes; }, [nodes]);
  useEffect(() => { edgesRef.current = edges; }, [edges]);

  useEffect(() => {
    setNodes(initialContent.nodes);
    setEdges(initialContent.edges);
  }, [initialContent]);

  // Inject label change callback into each node's data so DiagramNode can update it.
  const nodesWithCallbacks = nodes.map((n) => {
    if (n.type !== "diagramNode") return n;
    return {
      ...n,
      data: {
        ...n.data,
        _onLabelChange: (newLabel: string) => {
          setNodes((prev) => {
            const next = prev.map((nd) =>
              nd.id === n.id ? { ...nd, data: { ...nd.data, label: newLabel } } : nd,
            );
            fireChange(next, edgesRef.current);
            return next;
          });
        },
      },
    };
  });

  const fireChange = useCallback((nextNodes: Node[], nextEdges: Edge[]) => {
    onChangeRef?.current?.({ nodes: nextNodes, edges: nextEdges });
  }, [onChangeRef]);

  const onNodesChange: OnNodesChange = useCallback((changes) => {
    if (readOnly) return;
    setNodes((nds) => {
      const next = applyNodeChanges(changes, nds);
      fireChange(next, edgesRef.current);
      return next;
    });
  }, [readOnly, fireChange]);

  const onEdgesChange: OnEdgesChange = useCallback((changes) => {
    if (readOnly) return;
    setEdges((eds) => {
      const next = applyEdgeChanges(changes, eds);
      fireChange(nodesRef.current, next);
      return next;
    });
  }, [readOnly, fireChange]);

  const onConnect: OnConnect = useCallback((connection) => {
    if (readOnly) return;
    setEdges((eds) => {
      const next = addEdge(
        { ...connection, markerEnd: { type: MarkerType.ArrowClosed }, animated: false },
        eds,
      );
      fireChange(nodesRef.current, next);
      return next;
    });
  }, [readOnly, fireChange]);

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (readOnly) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, [readOnly]);

  const onDrop = useCallback((e: React.DragEvent) => {
    if (readOnly || !rfInstance) return;
    const raw = e.dataTransfer.getData("application/bunny-diagram-node");
    if (!raw) return;
    e.preventDefault();

    let item: DiagramLibraryItem | { _type: "floatingArrow" | "floatingLine" };
    try {
      item = JSON.parse(raw) as typeof item;
    } catch {
      return;
    }

    const pos = rfInstance.screenToFlowPosition({ x: e.clientX, y: e.clientY });

    if ("_type" in item) {
      // Floating arrow / line: create two anchor nodes + one edge
      const isArrow = item._type === "floatingArrow";
      const startId = `a${Date.now()}`;
      const endId = `a${Date.now() + 1}`;
      const edgeId = `e${Date.now()}`;
      const startNode: Node = {
        id: startId,
        type: "anchorPoint",
        position: { x: pos.x - 60, y: pos.y },
        data: {},
        draggable: true,
      };
      const endNode: Node = {
        id: endId,
        type: "anchorPoint",
        position: { x: pos.x + 60, y: pos.y },
        data: {},
        draggable: true,
      };
      const edge: Edge = {
        id: edgeId,
        source: startId,
        target: endId,
        markerEnd: isArrow ? { type: MarkerType.ArrowClosed } : undefined,
        label: "",
        type: "default",
      };
      setNodes((nds) => {
        const next = [...nds, startNode, endNode];
        fireChange(next, [...edgesRef.current, edge]);
        return next;
      });
      setEdges((eds) => [...eds, edge]);
      return;
    }

    // Normal library node
    const libItem = item as DiagramLibraryItem;
    const id = `n${Date.now()}`;
    const newNode: Node = {
      id,
      type: "diagramNode",
      position: { x: pos.x - libItem.width / 2, y: pos.y - libItem.height / 2 },
      data: {
        label: libItem.name,
        shape: libItem.shape,
        iconName: libItem.iconName,
        color: libItem.color,
        description: libItem.description,
        libraryItemId: libItem.id,
      } satisfies DiagramNodeData,
      style: { width: libItem.width, minHeight: libItem.height },
    };

    setNodes((nds) => {
      const next = [...nds, newNode];
      fireChange(next, edgesRef.current);
      return next;
    });
  }, [readOnly, rfInstance, fireChange]);

  // ── Context menu ────────────────────────────────────────────────────────
  const onNodeContextMenu = useCallback((e: React.MouseEvent, node: Node) => {
    if (readOnly) return;
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, targetId: node.id, targetType: "node" });
  }, [readOnly]);

  const onEdgeContextMenu = useCallback((e: React.MouseEvent, edge: Edge) => {
    if (readOnly) return;
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, targetId: edge.id, targetType: "edge" });
  }, [readOnly]);

  const closeCtxMenu = useCallback(() => setCtxMenu(null), []);

  const ctxDelete = useCallback(() => {
    if (!ctxMenu) return;
    if (ctxMenu.targetType === "node") {
      setNodes((nds) => {
        const next = nds.filter((n) => n.id !== ctxMenu.targetId);
        // also remove edges connected to deleted node
        setEdges((eds) => {
          const nextE = eds.filter(
            (e) => e.source !== ctxMenu.targetId && e.target !== ctxMenu.targetId,
          );
          fireChange(next, nextE);
          return nextE;
        });
        return next;
      });
    } else {
      setEdges((eds) => {
        const next = eds.filter((e) => e.id !== ctxMenu.targetId);
        fireChange(nodesRef.current, next);
        return next;
      });
    }
    closeCtxMenu();
  }, [ctxMenu, closeCtxMenu, fireChange]);

  const ctxToggleArrow = useCallback(() => {
    if (!ctxMenu || ctxMenu.targetType !== "edge") return;
    setEdges((eds) => {
      const next = eds.map((e) =>
        e.id === ctxMenu.targetId
          ? {
              ...e,
              markerEnd: e.markerEnd ? undefined : { type: MarkerType.ArrowClosed },
              markerStart: undefined,
            }
          : e,
      );
      fireChange(nodesRef.current, next);
      return next;
    });
    closeCtxMenu();
  }, [ctxMenu, closeCtxMenu, fireChange]);

  const ctxToggleDash = useCallback(() => {
    if (!ctxMenu || ctxMenu.targetType !== "edge") return;
    setEdges((eds) => {
      const next = eds.map((e) =>
        e.id === ctxMenu.targetId
          ? { ...e, style: { ...e.style, strokeDasharray: e.style?.strokeDasharray ? undefined : "6 3" } }
          : e,
      );
      fireChange(nodesRef.current, next);
      return next;
    });
    closeCtxMenu();
  }, [ctxMenu, closeCtxMenu, fireChange]);

  const ctxEditLabel = useCallback(() => {
    if (!ctxMenu) return;
    if (ctxMenu.targetType === "edge") {
      const edge = edgesRef.current.find((e) => e.id === ctxMenu.targetId);
      if (edge) {
        setEdgeLabelEdit({
          edgeId: edge.id,
          x: ctxMenu.x,
          y: ctxMenu.y,
          currentLabel: String(edge.label ?? ""),
        });
      }
    }
    closeCtxMenu();
  }, [ctxMenu, closeCtxMenu]);

  const ctxDuplicate = useCallback(() => {
    if (!ctxMenu || ctxMenu.targetType !== "node") return;
    const node = nodesRef.current.find((n) => n.id === ctxMenu.targetId);
    if (!node) { closeCtxMenu(); return; }
    const id = `n${Date.now()}`;
    const clone: Node = {
      ...node,
      id,
      position: { x: node.position.x + 20, y: node.position.y + 20 },
      selected: false,
    };
    setNodes((nds) => {
      const next = [...nds, clone];
      fireChange(next, edgesRef.current);
      return next;
    });
    closeCtxMenu();
  }, [ctxMenu, closeCtxMenu, fireChange]);

  // ── Edge double-click label editing ─────────────────────────────────────
  const onEdgeDoubleClick = useCallback((e: React.MouseEvent, edge: Edge) => {
    if (readOnly) return;
    setEdgeLabelEdit({
      edgeId: edge.id,
      x: e.clientX,
      y: e.clientY,
      currentLabel: String(edge.label ?? ""),
    });
  }, [readOnly]);

  const commitEdgeLabel = useCallback((value: string) => {
    if (!edgeLabelEdit) return;
    setEdges((eds) => {
      const next = eds.map((e) =>
        e.id === edgeLabelEdit.edgeId ? { ...e, label: value } : e,
      );
      fireChange(nodesRef.current, next);
      return next;
    });
    setEdgeLabelEdit(null);
  }, [edgeLabelEdit, fireChange]);

  useImperativeHandle(innerRef, () => ({
    getContent: () => ({ nodes: nodesRef.current, edges: edgesRef.current }),
    setContent: (c) => {
      setNodes(c.nodes);
      setEdges(c.edges);
    },
    captureThumb: () => {
      const svg = containerRef.current?.querySelector<SVGSVGElement>(".react-flow__renderer svg");
      if (!svg) return null;
      try {
        return `data:image/svg+xml,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
      } catch {
        return null;
      }
    },
  }), []);

  return (
    <div
      ref={containerRef}
      style={{ width: "100%", height: "100%" }}
      onClick={closeCtxMenu}
      onContextMenu={(e) => e.preventDefault()}
    >
      <ReactFlow
        nodes={nodesWithCallbacks}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onInit={setRfInstance}
        onNodeContextMenu={onNodeContextMenu}
        onEdgeContextMenu={onEdgeContextMenu}
        onEdgeDoubleClick={onEdgeDoubleClick}
        onPaneClick={closeCtxMenu}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        elementsSelectable={!readOnly}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        deleteKeyCode={readOnly ? null : "Delete"}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>

      {/* Context menu */}
      {ctxMenu && (
        <div
          className="dn-ctx-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {ctxMenu.targetType === "node" && (
            <>
              <button className="dn-ctx-menu__item" onClick={ctxDuplicate}>Duplicate</button>
              <div className="dn-ctx-menu__sep" />
            </>
          )}
          {ctxMenu.targetType === "edge" && (
            <>
              <button className="dn-ctx-menu__item" onClick={ctxEditLabel}>Edit label…</button>
              <button className="dn-ctx-menu__item" onClick={ctxToggleArrow}>Toggle arrow</button>
              <button className="dn-ctx-menu__item" onClick={ctxToggleDash}>Toggle dashed</button>
              <div className="dn-ctx-menu__sep" />
            </>
          )}
          <button className="dn-ctx-menu__item dn-ctx-menu__item--danger" onClick={ctxDelete}>
            Delete
          </button>
        </div>
      )}

      {/* Inline edge label editor */}
      {edgeLabelEdit && (
        <EdgeLabelInputPopup
          x={edgeLabelEdit.x}
          y={edgeLabelEdit.y}
          initial={edgeLabelEdit.currentLabel}
          onCommit={commitEdgeLabel}
          onCancel={() => setEdgeLabelEdit(null)}
        />
      )}
    </div>
  );
}

function EdgeLabelInputPopup({
  x, y, initial, onCommit, onCancel,
}: {
  x: number; y: number; initial: string;
  onCommit: (v: string) => void; onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <div className="dn-edge-label-popup" style={{ left: x, top: y }}>
      <input
        className="dn-edge-label-popup__input"
        value={value}
        autoFocus
        placeholder="Edge label…"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onCommit(value);
          if (e.key === "Escape") onCancel();
        }}
        onBlur={() => onCommit(value)}
      />
    </div>
  );
}

interface WrapperProps {
  initialContent: DiagramContent;
  readOnly?: boolean;
  onChangeRef?: React.MutableRefObject<((content: DiagramContent) => void) | null>;
  innerRef: React.Ref<DiagramCanvasRef>;
}

export default function DiagramCanvas(props: WrapperProps) {
  return (
    <ReactFlowProvider>
      <DiagramCanvasInner {...props} />
    </ReactFlowProvider>
  );
}
