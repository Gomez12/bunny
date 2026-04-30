/**
 * Write the canonical `graph.json` + `meta.json` into `<outDirAbs>/`. The
 * out-dir is kept *outside* the cloned repo (see `graphOutDirForRoot` in
 * `run.ts`) so re-clones, gitignore drift, and editor "noise" indicators
 * don't fight with our scratch state. The frontend loads both via the
 * workspace file endpoint — no HTML template, rendering is client-side.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GRAMMAR_VERSIONS } from "./grammars.ts";
import type {
  ClusterSummary,
  GraphEdge,
  GraphMeta,
  GraphNode,
  PersistedGraph,
} from "./types.ts";

export interface RenderOpts {
  outDirAbs: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  clusters: ClusterSummary[];
  godNodes: string[];
  bridgeNodes: string[];
  languageHisto: Record<string, number>;
  docExtractionEnabled: boolean;
}

export interface RenderedGraph {
  /** Where `graph.json` / `meta.json` / `GRAPH_REPORT.md` live. */
  outDir: string;
  meta: GraphMeta;
  persisted: PersistedGraph;
}

export function renderGraphArtefacts(opts: RenderOpts): RenderedGraph {
  const outDir = opts.outDirAbs;
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const persisted: PersistedGraph = {
    nodes: opts.nodes,
    edges: opts.edges,
    clusters: opts.clusters,
    godNodes: opts.godNodes,
    bridgeNodes: opts.bridgeNodes,
  };
  writeFileSync(join(outDir, "graph.json"), JSON.stringify(persisted), "utf8");

  const meta: GraphMeta = {
    nodeCount: opts.nodes.length,
    edgeCount: opts.edges.length,
    clusterCount: opts.clusters.length,
    languages: opts.languageHisto,
    generatedAt: Date.now(),
    grammarVersions: { ...GRAMMAR_VERSIONS },
    docExtractionEnabled: opts.docExtractionEnabled,
  };
  writeFileSync(
    join(outDir, "meta.json"),
    JSON.stringify(meta, null, 2),
    "utf8",
  );

  return { outDir, meta, persisted };
}

export function writeGraphReport(
  outDir: string,
  markdown: string,
): void {
  writeFileSync(join(outDir, "GRAPH_REPORT.md"), markdown, "utf8");
}
