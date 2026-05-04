/**
 * Per-file AST extraction. Each source language contributes:
 *   - one `module` node (per file)
 *   - one node per top-level function / class / method declaration
 *   - one `imports` edge from the file's module to each resolvable import target
 *
 * We deliberately do NOT emit call-graph edges in v1. Call resolution is hard
 * across languages (dynamic dispatch, type inference) and the noise ratio
 * from naive name-matching is bad enough to hide the actual structure.
 * When the signal matters, graphify's LLM doc-extraction pass (`extract/docs`)
 * augments the graph with `mentions` edges that carry calling relationships.
 *
 * Languages without a dedicated walker (`java`, `c`, `cpp`, `rb`, `php` in v1)
 * fall through to `moduleOnlyExtraction` — one node per file, no edges. This
 * keeps coverage graceful rather than binary.
 */

import type Parser from "web-tree-sitter";
import { langForFile, parserFor, type LangKey } from "../grammars.ts";
import type { FileExtraction, GraphEdge, GraphNode } from "../types.ts";

type TsNode =
  ReturnType<Parser["parse"]> extends infer T
    ? T extends null | undefined
      ? never
      : T extends { rootNode: infer R }
        ? R
        : never
    : never;

// The narrow node-surface we actually use across walkers. `web-tree-sitter`'s
// types are awkward at 0.22; this typing is enough.
interface SNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  namedChildCount: number;
  namedChild(i: number): SNode | null;
  childForFieldName(name: string): SNode | null;
  firstNamedChild: SNode | null;
}

function moduleIdFor(relPath: string): string {
  return `${relPath}#module`;
}

function nodeId(
  relPath: string,
  kind: string,
  name: string,
  line: number,
): string {
  return `${relPath}#${kind}:${name}@${line}`;
}

function moduleOnlyExtraction(relPath: string): FileExtraction {
  return {
    nodes: [
      {
        id: moduleIdFor(relPath),
        kind: "module",
        name: relPath,
        filePath: relPath,
      },
    ],
    edges: [],
  };
}

function iterNamed(node: SNode): SNode[] {
  const out: SNode[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c) out.push(c);
  }
  return out;
}

/** Depth-first walk that collects every named descendant matching `test`. */
function collect(node: SNode, test: (n: SNode) => boolean): SNode[] {
  const out: SNode[] = [];
  const stack: SNode[] = [node];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const child of iterNamed(cur)) {
      if (test(child)) out.push(child);
      stack.push(child);
    }
  }
  return out;
}

function identName(n: SNode | null): string | null {
  if (!n) return null;
  const text = n.text.trim();
  return text.length > 0 ? text : null;
}

// ── TypeScript / TSX / JavaScript ───────────────────────────────────────────

function extractTsJs(relPath: string, root: SNode): FileExtraction {
  const nodes: GraphNode[] = [
    {
      id: moduleIdFor(relPath),
      kind: "module",
      name: relPath,
      filePath: relPath,
    },
  ];
  const edges: GraphEdge[] = [];

  const decls = collect(root, (n) =>
    [
      "function_declaration",
      "method_definition",
      "class_declaration",
      "interface_declaration",
    ].includes(n.type),
  );
  for (const d of decls) {
    const nameNode = d.childForFieldName("name");
    const name = identName(nameNode);
    if (!name) continue;
    const kind =
      d.type === "class_declaration" || d.type === "interface_declaration"
        ? "class"
        : d.type === "method_definition"
          ? "method"
          : "function";
    nodes.push({
      id: nodeId(relPath, kind, name, d.startPosition.row + 1),
      kind,
      name,
      filePath: relPath,
      lineStart: d.startPosition.row + 1,
      lineEnd: d.endPosition.row + 1,
    });
  }

  const imports = collect(root, (n) => n.type === "import_statement");
  for (const imp of imports) {
    const source = imp.childForFieldName("source");
    const raw = source?.text.trim() ?? "";
    const stripped = raw.replace(/^['"`]|['"`]$/g, "");
    if (!stripped) continue;
    const targetId = `external:${stripped}`;
    if (!nodes.find((n) => n.id === targetId)) {
      nodes.push({
        id: targetId,
        kind: "module",
        name: stripped,
        filePath: null,
      });
    }
    edges.push({
      from: moduleIdFor(relPath),
      to: targetId,
      kind: "imports",
      confidence: 1,
    });
  }

  return { nodes, edges };
}

// ── Python ───────────────────────────────────────────────────────────────────

function extractPython(relPath: string, root: SNode): FileExtraction {
  const nodes: GraphNode[] = [
    {
      id: moduleIdFor(relPath),
      kind: "module",
      name: relPath,
      filePath: relPath,
    },
  ];
  const edges: GraphEdge[] = [];

  const decls = collect(
    root,
    (n) => n.type === "function_definition" || n.type === "class_definition",
  );
  for (const d of decls) {
    const nameNode = d.childForFieldName("name");
    const name = identName(nameNode);
    if (!name) continue;
    const isMethod =
      d.type === "function_definition" &&
      hasAncestorType(root, d, "class_definition");
    const kind =
      d.type === "class_definition"
        ? "class"
        : isMethod
          ? "method"
          : "function";
    nodes.push({
      id: nodeId(relPath, kind, name, d.startPosition.row + 1),
      kind,
      name,
      filePath: relPath,
      lineStart: d.startPosition.row + 1,
      lineEnd: d.endPosition.row + 1,
    });
  }

  const imports = collect(
    root,
    (n) => n.type === "import_statement" || n.type === "import_from_statement",
  );
  const pushImport = (target: string): void => {
    const targetId = `external:${target}`;
    if (!nodes.find((n) => n.id === targetId)) {
      nodes.push({
        id: targetId,
        kind: "module",
        name: target,
        filePath: null,
      });
    }
    edges.push({
      from: moduleIdFor(relPath),
      to: targetId,
      kind: "imports",
      confidence: 1,
    });
  };
  for (const imp of imports) {
    if (imp.type === "import_from_statement") {
      const target = identName(imp.childForFieldName("module_name"));
      if (target) pushImport(target);
      continue;
    }
    // `import_statement` — iterate named children of type `dotted_name`.
    for (const c of iterNamed(imp)) {
      if (c.type === "dotted_name" || c.type === "aliased_import") {
        const real =
          c.type === "aliased_import" ? c.childForFieldName("name") : c;
        const target = identName(real);
        if (target) pushImport(target);
      }
    }
  }

  return { nodes, edges };
}

// Ancestor-type lookup: tree-sitter doesn't store parent pointers on the
// zero-copy node objects, so we re-walk from root to find the path.
function hasAncestorType(
  root: SNode,
  target: SNode,
  ancestorType: string,
): boolean {
  type Frame = { node: SNode; stack: string[] };
  const queue: Frame[] = [{ node: root, stack: [] }];
  while (queue.length > 0) {
    const { node, stack } = queue.shift()!;
    for (const child of iterNamed(node)) {
      if (sameNode(child, target)) return stack.includes(ancestorType);
      queue.push({ node: child, stack: [...stack, child.type] });
    }
  }
  return false;
}

function sameNode(a: SNode, b: SNode): boolean {
  return (
    a.type === b.type &&
    a.startPosition.row === b.startPosition.row &&
    a.startPosition.column === b.startPosition.column &&
    a.endPosition.row === b.endPosition.row &&
    a.endPosition.column === b.endPosition.column
  );
}

// ── Go ───────────────────────────────────────────────────────────────────────

function extractGo(relPath: string, root: SNode): FileExtraction {
  const nodes: GraphNode[] = [
    {
      id: moduleIdFor(relPath),
      kind: "module",
      name: relPath,
      filePath: relPath,
    },
  ];
  const edges: GraphEdge[] = [];

  const decls = collect(root, (n) =>
    ["function_declaration", "method_declaration", "type_declaration"].includes(
      n.type,
    ),
  );
  for (const d of decls) {
    if (d.type === "type_declaration") {
      // Dig for `type_spec` inside.
      for (const spec of iterNamed(d)) {
        if (spec.type !== "type_spec") continue;
        const name = identName(spec.childForFieldName("name"));
        if (!name) continue;
        nodes.push({
          id: nodeId(relPath, "class", name, spec.startPosition.row + 1),
          kind: "class",
          name,
          filePath: relPath,
          lineStart: spec.startPosition.row + 1,
          lineEnd: spec.endPosition.row + 1,
        });
      }
      continue;
    }
    const name = identName(d.childForFieldName("name"));
    if (!name) continue;
    const kind = d.type === "method_declaration" ? "method" : "function";
    nodes.push({
      id: nodeId(relPath, kind, name, d.startPosition.row + 1),
      kind,
      name,
      filePath: relPath,
      lineStart: d.startPosition.row + 1,
      lineEnd: d.endPosition.row + 1,
    });
  }

  const imports = collect(root, (n) => n.type === "import_spec");
  for (const imp of imports) {
    const path = identName(imp.childForFieldName("path"));
    const target = path?.replace(/^['"`]|['"`]$/g, "");
    if (!target) continue;
    const targetId = `external:${target}`;
    if (!nodes.find((n) => n.id === targetId)) {
      nodes.push({
        id: targetId,
        kind: "module",
        name: target,
        filePath: null,
      });
    }
    edges.push({
      from: moduleIdFor(relPath),
      to: targetId,
      kind: "imports",
      confidence: 1,
    });
  }

  return { nodes, edges };
}

// ── Rust ─────────────────────────────────────────────────────────────────────

function extractRust(relPath: string, root: SNode): FileExtraction {
  const nodes: GraphNode[] = [
    {
      id: moduleIdFor(relPath),
      kind: "module",
      name: relPath,
      filePath: relPath,
    },
  ];
  const edges: GraphEdge[] = [];

  const decls = collect(root, (n) =>
    [
      "function_item",
      "struct_item",
      "enum_item",
      "trait_item",
      "impl_item",
    ].includes(n.type),
  );
  for (const d of decls) {
    const name = identName(d.childForFieldName("name"));
    if (!name) continue;
    const kind =
      d.type === "function_item"
        ? "function"
        : d.type === "trait_item"
          ? "class"
          : d.type === "impl_item"
            ? "method"
            : "class";
    nodes.push({
      id: nodeId(relPath, kind, name, d.startPosition.row + 1),
      kind,
      name,
      filePath: relPath,
      lineStart: d.startPosition.row + 1,
      lineEnd: d.endPosition.row + 1,
    });
  }

  const useDecls = collect(root, (n) => n.type === "use_declaration");
  for (const u of useDecls) {
    const text = u.text
      .trim()
      .replace(/^use\s+/, "")
      .replace(/;$/, "");
    if (!text) continue;
    const targetId = `external:${text}`;
    if (!nodes.find((n) => n.id === targetId)) {
      nodes.push({
        id: targetId,
        kind: "module",
        name: text,
        filePath: null,
      });
    }
    edges.push({
      from: moduleIdFor(relPath),
      to: targetId,
      kind: "imports",
      confidence: 1,
    });
  }

  return { nodes, edges };
}

// ── Dispatcher ───────────────────────────────────────────────────────────────

const WALKERS: Partial<
  Record<LangKey, (rel: string, root: SNode) => FileExtraction>
> = {
  ts: extractTsJs,
  tsx: extractTsJs,
  js: extractTsJs,
  py: extractPython,
  go: extractGo,
  rs: extractRust,
};

export async function extractCodeFile(
  relPath: string,
  sourceText: string,
): Promise<FileExtraction> {
  const lang = langForFile(relPath);
  if (!lang) return moduleOnlyExtraction(relPath);
  const walker = WALKERS[lang];
  if (!walker) return moduleOnlyExtraction(relPath);

  const parser = await parserFor(lang);
  if (!parser) return moduleOnlyExtraction(relPath);

  try {
    const tree = parser.parse(sourceText);
    if (!tree) return moduleOnlyExtraction(relPath);
    return walker(relPath, tree.rootNode as unknown as SNode);
  } catch {
    return moduleOnlyExtraction(relPath);
  }
}
