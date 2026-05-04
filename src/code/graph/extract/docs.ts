/**
 * LLM-powered doc extraction — reads .md / .pdf / .docx files, calls the
 * `code.graph.doc_extract` prompt via the LLM adapter, parses the fenced
 * JSON, and returns a `FileExtraction`. Off by default
 * (`cfg.code.graph.docExtractionEnabled`); when enabled, the UI surfaces a
 * "will issue up to N LLM calls" disclaimer before kicking off a run.
 *
 * This path calls the LLM adapter directly instead of routing through
 * `runAgent` — we want one shot, no tools, no session bookkeeping.
 */

import { readFile, readFileSync } from "node:fs";
import type { LlmConfig } from "../../../config.ts";
import { chatSync } from "../../../llm/adapter.ts";
import { resolvePrompt, interpolate } from "../../../prompts/resolve.ts";
import type { FileExtraction, GraphEdge, GraphNode } from "../types.ts";

const MAX_DOC_CONTENT_CHARS = 24_000;

export interface DocExtractOpts {
  /** Project used for prompt-override resolution. */
  project: string;
  llmCfg: LlmConfig;
  /** Hard cap across the whole run (graphify respects a single budget). */
  totalBudget: { remaining: number };
}

/** Extract plain text from a doc file. Returns `undefined` on read failure. */
export async function readDocText(
  absPath: string,
): Promise<string | undefined> {
  const lower = absPath.toLowerCase();
  try {
    if (lower.endsWith(".md") || lower.endsWith(".markdown")) {
      return readFileSync(absPath, "utf8");
    }
    if (lower.endsWith(".pdf")) {
      return await pdfToText(absPath);
    }
    if (lower.endsWith(".docx")) {
      return await docxToText(absPath);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function pdfToText(absPath: string): Promise<string> {
  // pdfjs-dist ships as an ESM module; the Bun/Node build is under the
  // `legacy` subpath. Worker is disabled by setting `disableWorker: true`.
  const pdfjs =
    (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as {
      getDocument(src: {
        data: Uint8Array;
        disableWorker: boolean;
        useSystemFonts: boolean;
      }): { promise: Promise<PdfDoc> };
    };
  const buf = await new Promise<Buffer>((resolve, reject) => {
    readFile(absPath, (err, data) => (err ? reject(err) : resolve(data)));
  });
  const data = new Uint8Array(buf);
  const task = pdfjs.getDocument({
    data,
    disableWorker: true,
    useSystemFonts: true,
  });
  const doc = await task.promise;
  const chunks: string[] = [];
  for (let i = 1; i <= Math.min(doc.numPages, 40); i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      .map((it: { str?: string }) => it.str ?? "")
      .join(" ");
    chunks.push(text);
    if (chunks.join("\n").length >= MAX_DOC_CONTENT_CHARS) break;
  }
  return chunks.join("\n");
}

interface PdfDoc {
  numPages: number;
  getPage(n: number): Promise<{
    getTextContent(): Promise<{ items: { str?: string }[] }>;
  }>;
}

async function docxToText(absPath: string): Promise<string> {
  const mammoth = (await import("mammoth")) as unknown as {
    extractRawText(opts: { path: string }): Promise<{ value: string }>;
  };
  const result = await mammoth.extractRawText({ path: absPath });
  return result.value;
}

/**
 * Ask the LLM to extract entities/edges from a single doc. Returns an empty
 * extraction on LLM failure, JSON parse failure, or budget exhaustion — the
 * caller should NOT abort the whole run for a single failed doc.
 */
export async function extractDocFile(
  relPath: string,
  absPath: string,
  opts: DocExtractOpts,
): Promise<FileExtraction> {
  if (opts.totalBudget.remaining <= 0) {
    return { nodes: [], edges: [] };
  }
  const text = await readDocText(absPath);
  if (!text) return { nodes: [], edges: [] };
  const truncated = text.slice(0, MAX_DOC_CONTENT_CHARS);
  const system = interpolate(
    resolvePrompt("code.graph.doc_extract", { project: opts.project }),
    { filePath: relPath, fileContent: truncated },
  );
  opts.totalBudget.remaining -= 1;
  let answer: string;
  try {
    const res = await chatSync(opts.llmCfg, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: "Return the JSON now." },
      ],
    });
    answer = typeof res.message.content === "string" ? res.message.content : "";
  } catch {
    return { nodes: [], edges: [] };
  }
  const parsed = parseDocExtractJson(answer);
  if (!parsed) return { nodes: [], edges: [] };
  return adaptExtractionForFile(relPath, parsed);
}

interface RawExtraction {
  nodes: Array<{ id?: string; kind?: string; name?: string }>;
  edges: Array<{
    from?: string;
    to?: string;
    kind?: string;
    confidence?: number;
  }>;
}

function parseDocExtractJson(text: string): RawExtraction | undefined {
  // Accept either a fenced ```json block or a bare JSON object.
  const fence = text.match(/```json\s*([\s\S]+?)\s*```/i);
  const candidate = fence?.[1] ?? text;
  try {
    const parsed = JSON.parse(candidate);
    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as RawExtraction).nodes) &&
      Array.isArray((parsed as RawExtraction).edges)
    ) {
      return parsed as RawExtraction;
    }
  } catch {
    /* fallthrough */
  }
  // Last-ditch: try to find the first `{…}` block and parse that.
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      const obj = JSON.parse(text.slice(firstBrace, lastBrace + 1));
      if (obj && Array.isArray(obj.nodes) && Array.isArray(obj.edges)) {
        return obj as RawExtraction;
      }
    } catch {
      /* give up */
    }
  }
  return undefined;
}

const ALLOWED_NODE_KINDS = [
  "module",
  "function",
  "class",
  "method",
  "concept",
] as const;
const ALLOWED_EDGE_KINDS = [
  "imports",
  "calls",
  "extends",
  "implements",
  "mentions",
] as const;

function adaptExtractionForFile(
  relPath: string,
  raw: RawExtraction,
): FileExtraction {
  const docModuleId = `${relPath}#doc`;
  const nodes: GraphNode[] = [
    {
      id: docModuleId,
      kind: "module",
      name: relPath,
      filePath: relPath,
    },
  ];
  const seen = new Set<string>([docModuleId]);
  for (const n of raw.nodes) {
    if (!n.id || !n.name) continue;
    const kind = (ALLOWED_NODE_KINDS as readonly string[]).includes(
      n.kind ?? "",
    )
      ? (n.kind as GraphNode["kind"])
      : "concept";
    const id = `${relPath}#${kind}:${n.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    nodes.push({ id, kind, name: n.name, filePath: relPath });
  }
  const resolveId = (raw: string): string | undefined => {
    for (const n of nodes) {
      if (n.id === raw) return n.id;
      if (n.name === raw) return n.id;
      if (n.id.endsWith(`:${raw}`)) return n.id;
    }
    return undefined;
  };
  const edges: GraphEdge[] = [];
  for (const e of raw.edges) {
    if (!e.from || !e.to) continue;
    const from = resolveId(e.from);
    const to = resolveId(e.to);
    if (!from || !to) continue;
    const kind = (ALLOWED_EDGE_KINDS as readonly string[]).includes(
      e.kind ?? "",
    )
      ? (e.kind as GraphEdge["kind"])
      : "mentions";
    const conf =
      typeof e.confidence === "number"
        ? Math.max(0.1, Math.min(0.9, e.confidence))
        : 0.5;
    edges.push({ from, to, kind, confidence: conf });
  }
  // Connect the doc module to each concept node so the graph stays connected.
  for (const n of nodes) {
    if (n.id === docModuleId) continue;
    edges.push({
      from: docModuleId,
      to: n.id,
      kind: "mentions",
      confidence: 0.6,
    });
  }
  return { nodes, edges };
}
