import { describe, test, expect } from "bun:test";
import { buildGraph, serialiseGraph } from "../../../src/code/graph/build.ts";
import { clusterGraph } from "../../../src/code/graph/cluster.ts";

describe("clusterGraph — Louvain", () => {
  test("detects two dense communities on a barbell graph", () => {
    const ex = [
      {
        nodes: "abcdef".split("").map((id) => ({
          id,
          kind: "module" as const,
          name: id,
          filePath: `${id}.ts`,
        })),
        edges: [
          { from: "a", to: "b", kind: "imports" as const, confidence: 1 },
          { from: "a", to: "c", kind: "imports" as const, confidence: 1 },
          { from: "b", to: "c", kind: "imports" as const, confidence: 1 },
          { from: "d", to: "e", kind: "imports" as const, confidence: 1 },
          { from: "d", to: "f", kind: "imports" as const, confidence: 1 },
          { from: "e", to: "f", kind: "imports" as const, confidence: 1 },
          // single weak bridge between the two groups
          { from: "c", to: "d", kind: "imports" as const, confidence: 0.1 },
        ],
      },
    ];
    const g = buildGraph(ex);
    const cr = clusterGraph(g);
    const s = serialiseGraph(g);

    const clusters = new Set(s.nodes.map((n) => n.cluster));
    expect(clusters.size).toBe(2);

    // a,b,c in one cluster; d,e,f in the other.
    const abc = new Set(
      s.nodes
        .filter((n) => ["a", "b", "c"].includes(n.id))
        .map((n) => n.cluster),
    );
    const def = new Set(
      s.nodes
        .filter((n) => ["d", "e", "f"].includes(n.id))
        .map((n) => n.cluster),
    );
    expect(abc.size).toBe(1);
    expect(def.size).toBe(1);
    expect([...abc][0]).not.toBe([...def][0]);

    expect(cr.godNodes.length).toBeGreaterThan(0);
    expect(cr.clusters.every((c) => c.topNodes.length > 0)).toBe(true);
  });

  test("serialiseGraph preserves all nodes and edges", () => {
    const ex = [
      {
        nodes: [
          {
            id: "a",
            kind: "module" as const,
            name: "a",
            filePath: "a.ts",
          },
          {
            id: "b",
            kind: "module" as const,
            name: "b",
            filePath: "b.ts",
          },
        ],
        edges: [
          { from: "a", to: "b", kind: "imports" as const, confidence: 0.7 },
        ],
      },
    ];
    const g = buildGraph(ex);
    const s = serialiseGraph(g);
    expect(s.nodes.length).toBe(2);
    expect(s.edges.length).toBe(1);
    expect(s.edges[0]!.confidence).toBeCloseTo(0.7);
  });
});
