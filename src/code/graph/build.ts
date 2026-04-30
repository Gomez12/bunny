/**
 * Merge per-file extractions into one `graphology` graph. Nodes are
 * deduplicated by id; edges by `(from, to, kind)` with confidence summed
 * and clipped to 1.0.
 */

import Graph from "graphology";
import type { FileExtraction, GraphEdge, GraphNode } from "./types.ts";

export function buildGraph(extractions: FileExtraction[]): Graph {
  const graph = new Graph({ type: "undirected", multi: false });

  for (const ex of extractions) {
    for (const node of ex.nodes) {
      if (!graph.hasNode(node.id)) {
        graph.addNode(node.id, { ...node });
      }
    }
  }

  for (const ex of extractions) {
    for (const edge of ex.edges) {
      if (!graph.hasNode(edge.from) || !graph.hasNode(edge.to)) continue;
      if (edge.from === edge.to) continue;
      const key = edgeKey(edge.from, edge.to, edge.kind);
      if (graph.hasEdge(key)) {
        const attrs = graph.getEdgeAttributes(key) as { confidence: number };
        const next = Math.min(1, attrs.confidence + edge.confidence);
        graph.setEdgeAttribute(key, "confidence", next);
      } else {
        graph.addEdgeWithKey(key, edge.from, edge.to, {
          kind: edge.kind,
          confidence: Math.min(1, edge.confidence),
        });
      }
    }
  }

  return graph;
}

function edgeKey(from: string, to: string, kind: string): string {
  // Sort endpoints to match the undirected-graph deduplication.
  const [a, b] = from < to ? [from, to] : [to, from];
  return `${a}|${b}|${kind}`;
}

export function serialiseGraph(graph: Graph): {
  nodes: GraphNode[];
  edges: GraphEdge[];
} {
  const nodes: GraphNode[] = graph.mapNodes((_, attrs) => ({
    ...(attrs as GraphNode),
  }));
  const edges: GraphEdge[] = graph.mapEdges((_, attrs, source, target) => ({
    from: source,
    to: target,
    kind: (attrs as { kind: GraphEdge["kind"] }).kind,
    confidence: (attrs as { confidence: number }).confidence,
  }));
  return { nodes, edges };
}
