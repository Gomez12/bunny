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
import DiagramNodeComponent, { type DiagramNodeData } from "./DiagramNode";
import type { DiagramLibraryItem } from "../../api";

const NODE_TYPES = { diagramNode: DiagramNodeComponent } as const;

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

function DiagramCanvasInner({ initialContent, readOnly, onChangeRef, innerRef }: Props) {
  const [nodes, setNodes] = useState<Node[]>(initialContent.nodes);
  const [edges, setEdges] = useState<Edge[]>(initialContent.edges);
  const [rfInstance, setRfInstance] = useState<ReactFlowInstance | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);

  useEffect(() => { nodesRef.current = nodes; }, [nodes]);
  useEffect(() => { edgesRef.current = edges; }, [edges]);

  useEffect(() => {
    setNodes(initialContent.nodes);
    setEdges(initialContent.edges);
  }, [initialContent]);

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

    let item: DiagramLibraryItem;
    try {
      item = JSON.parse(raw) as DiagramLibraryItem;
    } catch {
      return;
    }

    const pos = rfInstance.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const id = `n${Date.now()}`;
    const newNode: Node = {
      id,
      type: "diagramNode",
      position: { x: pos.x - item.width / 2, y: pos.y - item.height / 2 },
      data: {
        label: item.name,
        shape: item.shape,
        iconName: item.iconName,
        color: item.color,
        description: item.description,
        libraryItemId: item.id,
      } satisfies DiagramNodeData,
      style: { width: item.width, minHeight: item.height },
    };

    setNodes((nds) => {
      const next = [...nds, newNode];
      fireChange(next, edgesRef.current);
      return next;
    });
  }, [readOnly, rfInstance, fireChange]);

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
    <div ref={containerRef} style={{ width: "100%", height: "100%" }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onInit={setRfInstance}
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
