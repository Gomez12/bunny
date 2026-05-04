import { describe, test, expect } from "bun:test";
import { resolveInternalImports } from "../../../src/code/graph/run.ts";
import type { FileExtraction } from "../../../src/code/graph/types.ts";

/**
 * The extractor emits `external:./foo` for relative imports because it doesn't
 * know which sibling files exist. The post-pass in `run.ts` rewrites those
 * stubs to point at the actual `<path>#module` once the full file walk is
 * known — without this, internal modules never connect to each other and the
 * graph is just islands.
 */
describe("resolveInternalImports", () => {
  test("rewrites a relative import to the sibling's module id", () => {
    const ex: FileExtraction[] = [
      {
        nodes: [
          {
            id: "src/a.ts#module",
            kind: "module",
            name: "src/a.ts",
            filePath: "src/a.ts",
          },
          { id: "external:./b", kind: "module", name: "./b", filePath: null },
        ],
        edges: [
          {
            from: "src/a.ts#module",
            to: "external:./b",
            kind: "imports",
            confidence: 1,
          },
        ],
      },
      {
        nodes: [
          {
            id: "src/b.ts#module",
            kind: "module",
            name: "src/b.ts",
            filePath: "src/b.ts",
          },
        ],
        edges: [],
      },
    ];
    resolveInternalImports(ex, ["src/a.ts", "src/b.ts"]);
    expect(ex[0]!.edges[0]!.to).toBe("src/b.ts#module");
    expect(ex[0]!.nodes.find((n) => n.id === "external:./b")).toBeUndefined();
  });

  test("resolves paths through directory + extension lookup", () => {
    const ex: FileExtraction[] = [
      {
        nodes: [
          {
            id: "src/server/routes.ts#module",
            kind: "module",
            name: "src/server/routes.ts",
            filePath: "src/server/routes.ts",
          },
          {
            id: "external:../memory/db",
            kind: "module",
            name: "../memory/db",
            filePath: null,
          },
          {
            id: "external:./auth",
            kind: "module",
            name: "./auth",
            filePath: null,
          },
        ],
        edges: [
          {
            from: "src/server/routes.ts#module",
            to: "external:../memory/db",
            kind: "imports",
            confidence: 1,
          },
          {
            from: "src/server/routes.ts#module",
            to: "external:./auth",
            kind: "imports",
            confidence: 1,
          },
        ],
      },
    ];
    resolveInternalImports(ex, [
      "src/server/routes.ts",
      "src/memory/db.ts",
      "src/server/auth/index.ts",
    ]);
    expect(ex[0]!.edges[0]!.to).toBe("src/memory/db.ts#module");
    expect(ex[0]!.edges[1]!.to).toBe("src/server/auth/index.ts#module");
  });

  test("leaves true externals (bare specifiers) alone", () => {
    const ex: FileExtraction[] = [
      {
        nodes: [
          {
            id: "src/x.ts#module",
            kind: "module",
            name: "src/x.ts",
            filePath: "src/x.ts",
          },
          {
            id: "external:react",
            kind: "module",
            name: "react",
            filePath: null,
          },
        ],
        edges: [
          {
            from: "src/x.ts#module",
            to: "external:react",
            kind: "imports",
            confidence: 1,
          },
        ],
      },
    ];
    resolveInternalImports(ex, ["src/x.ts"]);
    expect(ex[0]!.edges[0]!.to).toBe("external:react");
    expect(ex[0]!.nodes).toHaveLength(2);
  });

  test("leaves a relative import as-is when the target is outside the walk", () => {
    const ex: FileExtraction[] = [
      {
        nodes: [
          {
            id: "src/x.ts#module",
            kind: "module",
            name: "src/x.ts",
            filePath: "src/x.ts",
          },
          {
            id: "external:./missing",
            kind: "module",
            name: "./missing",
            filePath: null,
          },
        ],
        edges: [
          {
            from: "src/x.ts#module",
            to: "external:./missing",
            kind: "imports",
            confidence: 1,
          },
        ],
      },
    ];
    resolveInternalImports(ex, ["src/x.ts"]);
    expect(ex[0]!.edges[0]!.to).toBe("external:./missing");
  });
});
