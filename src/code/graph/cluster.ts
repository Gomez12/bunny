/**
 * Louvain community clustering + god / bridge node selection.
 *
 * The algorithm flag in `cfg.code.graph.clusterAlgorithm` is reserved for a
 * future Leiden swap — today only "louvain" is wired. If we ever add Leiden,
 * branch on the flag here; everything else (node-to-cluster assignment,
 * top-nodes-per-cluster) is algorithm-agnostic.
 */

import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import betweennessCentrality from "graphology-metrics/centrality/betweenness.js";
import type { ClusterSummary } from "./types.ts";

const TOP_N_PER_CLUSTER = 3;
const GOD_NODES = 8;
const BRIDGE_NODES = 8;

export interface ClusterResult {
  clusters: ClusterSummary[];
  /** Top-N nodes by total degree across the whole graph. */
  godNodes: string[];
  /** Top-N nodes by betweenness centrality. */
  bridgeNodes: string[];
}

export function clusterGraph(graph: Graph): ClusterResult {
  // Louvain mutates node attrs: sets `community` (number) in-place.
  louvain.assign(graph, {
    getEdgeWeight: (_edge, attrs) =>
      (attrs as { confidence?: number }).confidence ?? 1,
  });

  // Propagate the label into the canonical `cluster` attribute we persist.
  graph.forEachNode((id) => {
    const community = graph.getNodeAttribute(id, "community") as
      | number
      | undefined;
    if (typeof community === "number") {
      graph.setNodeAttribute(id, "cluster", community);
    }
  });

  const members = new Map<number, string[]>();
  graph.forEachNode((id) => {
    const c = graph.getNodeAttribute(id, "cluster") as number | undefined;
    if (c === undefined) return;
    const list = members.get(c) ?? [];
    list.push(id);
    members.set(c, list);
  });

  const clusters: ClusterSummary[] = [];
  for (const [id, nodes] of members.entries()) {
    const ranked = [...nodes].sort(
      (a, b) => graph.degree(b) - graph.degree(a),
    );
    clusters.push({
      id,
      size: nodes.length,
      topNodes: ranked.slice(0, TOP_N_PER_CLUSTER),
    });
  }
  clusters.sort((a, b) => b.size - a.size);

  const allByDegree = graph.nodes().sort((a, b) => graph.degree(b) - graph.degree(a));
  const godNodes = allByDegree.slice(0, GOD_NODES);

  // Betweenness can be expensive on large graphs; skip when the graph is too
  // big to finish in reasonable time. Fall back to "highest degree across
  // clusters" as a proxy.
  let bridgeNodes: string[];
  if (graph.order <= 2000) {
    const bc = betweennessCentrality(graph) as Record<string, number>;
    bridgeNodes = Object.entries(bc)
      .sort(([, a], [, b]) => b - a)
      .slice(0, BRIDGE_NODES)
      .map(([id]) => id);
  } else {
    bridgeNodes = godNodes.filter((id) => {
      const c = graph.getNodeAttribute(id, "cluster") as number;
      const clusterSize = members.get(c)?.length ?? 0;
      return clusterSize >= 3;
    });
  }

  return { clusters, godNodes, bridgeNodes };
}
