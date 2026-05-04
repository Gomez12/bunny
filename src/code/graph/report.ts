/**
 * Build GRAPH_REPORT.md via a single LLM call. The summary we pass the model
 * is deliberately compact — cluster list with top-3 nodes per cluster, god
 * nodes, bridge nodes, and any cross-cluster edges among god/bridge nodes.
 * The prompt (`code.graph.report`) shapes the output.
 */

import type { LlmConfig } from "../../config.ts";
import { chatSync } from "../../llm/adapter.ts";
import { resolvePrompt, interpolate } from "../../prompts/resolve.ts";
import type { ClusterSummary, GraphEdge, GraphNode } from "./types.ts";

export interface ReportOpts {
  project: string;
  llmCfg: LlmConfig;
  codeProjectName: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  clusters: ClusterSummary[];
  godNodes: string[];
  bridgeNodes: string[];
}

/**
 * Build the report. Returns a deterministic fallback when the LLM call fails
 * (empty API key, network error, etc.) so a run never hangs waiting for a
 * report that will never arrive.
 */
export async function generateGraphReport(opts: ReportOpts): Promise<string> {
  const summary = buildSummaryText(opts);
  const fallback = buildDeterministicReport(opts, summary);
  if (!opts.llmCfg.apiKey) {
    return fallback;
  }
  const system = interpolate(
    resolvePrompt("code.graph.report", { project: opts.project }),
    {
      codeProjectName: opts.codeProjectName,
      graphSummary: summary,
    },
  );
  try {
    const res = await chatSync(opts.llmCfg, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: "Write the report now." },
      ],
    });
    const text =
      typeof res.message.content === "string" ? res.message.content : "";
    if (text.trim().length > 0) return text.trim() + "\n";
  } catch {
    /* fall through */
  }
  return fallback;
}

function buildSummaryText(opts: ReportOpts): string {
  const byId = new Map(opts.nodes.map((n) => [n.id, n]));
  const name = (id: string): string => {
    const n = byId.get(id);
    return n ? `${n.name} (${n.kind})` : id;
  };

  const lines: string[] = [];
  lines.push(`Nodes: ${opts.nodes.length}, edges: ${opts.edges.length}`);
  lines.push(`Clusters: ${opts.clusters.length}`);
  lines.push("");
  lines.push("Clusters (largest first):");
  for (const c of opts.clusters.slice(0, 8)) {
    const top = c.topNodes.map(name).join(", ");
    lines.push(`- cluster #${c.id} — ${c.size} nodes — top: ${top}`);
  }
  lines.push("");
  lines.push("God nodes (highest degree):");
  for (const id of opts.godNodes) {
    const n = byId.get(id);
    if (!n) continue;
    lines.push(`- ${n.name} (${n.kind}, cluster #${n.cluster ?? "?"})`);
  }
  lines.push("");
  lines.push("Bridge nodes (highest betweenness):");
  for (const id of opts.bridgeNodes) {
    const n = byId.get(id);
    if (!n) continue;
    lines.push(`- ${n.name} (${n.kind}, cluster #${n.cluster ?? "?"})`);
  }
  // Cross-cluster edges among the hub set — these are the interesting ones.
  const hubs = new Set<string>([...opts.godNodes, ...opts.bridgeNodes]);
  const cross = opts.edges
    .filter((e) => hubs.has(e.from) && hubs.has(e.to))
    .filter((e) => {
      const f = byId.get(e.from);
      const t = byId.get(e.to);
      return f && t && f.cluster !== t.cluster;
    })
    .slice(0, 10);
  if (cross.length > 0) {
    lines.push("");
    lines.push("Cross-cluster edges among hubs:");
    for (const e of cross) {
      lines.push(
        `- ${name(e.from)} -[${e.kind}]-> ${name(e.to)} (conf ${e.confidence.toFixed(2)})`,
      );
    }
  }
  return lines.join("\n");
}

function buildDeterministicReport(opts: ReportOpts, summary: string): string {
  const lines: string[] = [];
  lines.push(`# ${opts.codeProjectName} — graph report`);
  lines.push("");
  lines.push(
    "_Deterministic fallback — no LLM key was configured, so this report shows the raw summary the pipeline produced._",
  );
  lines.push("");
  lines.push("```");
  lines.push(summary);
  lines.push("```");
  lines.push("");
  return lines.join("\n");
}
