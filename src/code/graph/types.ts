/**
 * Shared types for the code knowledge-graph pipeline (ADR 0033). The on-disk
 * `graph.json` is a direct JSON serialisation of these types — callers on
 * the web side import this file for type safety.
 */

export type GraphNodeKind =
  | "module"
  | "function"
  | "class"
  | "method"
  | "concept";

export type GraphEdgeKind =
  | "imports"
  | "calls"
  | "extends"
  | "implements"
  | "mentions";

export interface GraphNode {
  /** Stable id — usually `<filePath>#<kind>:<name>` for AST nodes. */
  id: string;
  kind: GraphNodeKind;
  name: string;
  /** File the node was extracted from. `null` for synthetic nodes (e.g. external modules). */
  filePath: string | null;
  lineStart?: number;
  lineEnd?: number;
  /** Louvain community label. Populated by the cluster step. */
  cluster?: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: GraphEdgeKind;
  /**
   * 1.0 for deterministic AST extraction, < 1.0 for LLM-inferred edges. Merged
   * edges sum their confidence and clip to 1.0, so repeated AST evidence looks
   * as strong as a single AST edge.
   */
  confidence: number;
}

/** Output of a single per-file extraction (AST walker or docs extractor). */
export interface FileExtraction {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Canonical on-disk `graph.json` shape. */
export interface PersistedGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  clusters: ClusterSummary[];
  godNodes: string[];
  bridgeNodes: string[];
}

export interface ClusterSummary {
  id: number;
  size: number;
  /** Top-N node ids by degree inside the cluster. */
  topNodes: string[];
}

/** On-disk `meta.json` shape — cheap to read, suitable for etag-style checks. */
export interface GraphMeta {
  nodeCount: number;
  edgeCount: number;
  clusterCount: number;
  languages: Record<string, number>;
  generatedAt: number;
  /** Tree-sitter grammar version per language, used as cache key. */
  grammarVersions: Record<string, string>;
  docExtractionEnabled: boolean;
}
