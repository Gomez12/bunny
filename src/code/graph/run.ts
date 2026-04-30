/**
 * Detached runner for the code-graph pipeline (ADR 0033). Mirrors
 * `src/code/clone.ts`'s shape:
 *
 *   setGraphPhase → walk files → extract per file (cache) → build graph →
 *   cluster → render JSON → write report → setGraphReady
 *
 * Status transitions: idle → extracting → clustering → rendering →
 * ready | error. Race-safe via `setGraphPhase("extracting")`; lost races
 * return false without side effects. The caller wires the returned fanout
 * into the SSE response so the UI sees progress lines as they happen.
 */

import { readFileSync, rmSync } from "node:fs";
import { basename, dirname, join, posix } from "node:path";
import type { Database } from "bun:sqlite";
import type { BunnyConfig } from "../../config.ts";
import type { BunnyQueue } from "../../queue/bunqueue.ts";
import { safeWorkspacePath } from "../../memory/workspace_fs.ts";
import {
  createFanout,
  createFanoutRegistry,
  sendSseEvent,
  type FanoutRegistry,
} from "../../agent/run_fanout.ts";
import {
  getCodeProject,
  setGraphPhase,
  setGraphReady,
  setGraphError,
  type CodeProject,
} from "../../memory/code_projects.ts";
import { workspaceRelForCode } from "../clone.ts";
import { errorMessage } from "../../util/error.ts";
import { ensureCacheDir, readCache, sha256Hex, writeCache } from "./cache.ts";
import { langForFile, GRAMMAR_VERSIONS } from "./grammars.ts";
import { buildGraph, serialiseGraph } from "./build.ts";
import { clusterGraph } from "./cluster.ts";
import { renderGraphArtefacts, writeGraphReport } from "./render.ts";
import { extractCodeFile } from "./extract/code.ts";
import { extractDocFile, readDocText } from "./extract/docs.ts";
import { generateGraphReport } from "./report.ts";
import { walkCodeProject } from "./walk.ts";
import type { FileExtraction, GraphMeta } from "./types.ts";

const CODE_EXTRACTOR_VERSION = "1";
const DOC_EXTRACTOR_VERSION = "1";

/** Per-code-project fanout registry, keyed by `codeProjects.id`. */
export const graphFanouts: FanoutRegistry<GraphFanoutMeta> =
  createFanoutRegistry<GraphFanoutMeta>();

export interface GraphFanoutMeta {
  codeProjectId: number;
}

export interface RunGraphCtx {
  db: Database;
  queue: BunnyQueue;
  cfg: BunnyConfig;
  userId: string | null;
}

export interface RunGraphResult {
  ok: boolean;
  /** Set when we win the race; the caller hands this to the fanout subscriber. */
  fanoutRunId?: number;
}

/**
 * Kick off a run. Returns { ok: false } when the run could not be claimed
 * (e.g. not ready, unknown id, already running). A successful claim sets
 * `graph_status = 'extracting'` and the fanout stays alive for up to
 * `cfg.code.graph.timeoutMs + 60s`.
 */
export async function runGraph(
  ctx: RunGraphCtx,
  codeProjectId: number,
): Promise<RunGraphResult> {
  const cp = getCodeProject(ctx.db, codeProjectId);
  if (!cp) return { ok: false };
  if (cp.gitStatus !== "ready") return { ok: false };
  if (!setGraphPhase(ctx.db, codeProjectId, "extracting")) {
    return { ok: false };
  }

  // Resolve workspace paths up-front so we can abort cleanly on misconfigured
  // workspaces before any LLM/extraction cost.
  let rootAbs: string;
  let outDirAbs: string;
  try {
    const { abs } = safeWorkspacePath(cp.project, workspaceRelForCode(cp));
    rootAbs = abs;
    outDirAbs = graphOutDirForRoot(rootAbs);
  } catch (e) {
    const msg = errorMessage(e);
    setGraphError(ctx.db, codeProjectId, msg);
    return { ok: false };
  }

  const { fanout, sink } = createFanout<GraphFanoutMeta>(graphFanouts, {
    runId: codeProjectId,
    meta: { codeProjectId },
  });

  void ctx.queue.log({
    topic: "code",
    kind: "graph.start",
    userId: ctx.userId ?? undefined,
    data: { id: codeProjectId, project: cp.project, name: cp.name },
  });

  sendSseEvent(sink, {
    type: "code_graph_run_started",
    codeProjectId,
  });

  const started = Date.now();
  let aborted = false;
  const timeout = setTimeout(() => {
    aborted = true;
  }, ctx.cfg.code.graph.timeoutMs);

  void (async () => {
    try {
      const result = await runPhases(
        ctx,
        cp,
        rootAbs,
        outDirAbs,
        sink,
        () => aborted,
      );
      clearTimeout(timeout);
      if (aborted) {
        throw new Error("graph run exceeded timeout");
      }
      setGraphReady(ctx.db, codeProjectId, {
        nodes: result.meta.nodeCount,
        edges: result.meta.edgeCount,
      });
      sendSseEvent(sink, {
        type: "code_graph_run_finished",
        codeProjectId,
        status: "ready",
        nodes: result.meta.nodeCount,
        edges: result.meta.edgeCount,
      });
      void ctx.queue.log({
        topic: "code",
        kind: "graph.success",
        userId: ctx.userId ?? undefined,
        data: {
          id: codeProjectId,
          project: cp.project,
          durationMs: Date.now() - started,
          nodes: result.meta.nodeCount,
          edges: result.meta.edgeCount,
        },
      });
    } catch (e) {
      clearTimeout(timeout);
      const msg = errorMessage(e);
      setGraphError(ctx.db, codeProjectId, msg);
      sendSseEvent(sink, {
        type: "code_graph_run_finished",
        codeProjectId,
        status: "error",
        error: msg,
      });
      void ctx.queue.log({
        topic: "code",
        kind: "graph.error",
        userId: ctx.userId ?? undefined,
        data: { id: codeProjectId, project: cp.project, error: msg },
      });
    } finally {
      sink.close();
    }
  })();

  return { ok: true, fanoutRunId: codeProjectId };
}

interface PhaseResult {
  meta: GraphMeta;
}

async function runPhases(
  ctx: RunGraphCtx,
  cp: CodeProject,
  rootAbs: string,
  outDirAbs: string,
  sink: ReturnType<typeof createFanout<GraphFanoutMeta>>["sink"],
  isAborted: () => boolean,
): Promise<PhaseResult> {
  const cfg = ctx.cfg.code.graph;

  // Wipe the previous graph artefacts (graph.json / meta.json / report) to
  // avoid stale meta; the cache lives inside outDir and we recreate it just
  // below. We also wipe any legacy in-repo `graph-out/` left behind by an
  // earlier version of this code that wrote inside the cloned tree.
  try {
    rmSync(outDirAbs, { recursive: true, force: true });
  } catch {
    /* non-fatal */
  }
  try {
    rmSync(join(rootAbs, "graph-out"), { recursive: true, force: true });
  } catch {
    /* non-fatal */
  }
  const cacheDirs = ensureCacheDir(outDirAbs);

  // ── Walk ────────────────────────────────────────────────────────────────
  const walked = walkCodeProject({
    rootAbs,
    maxFiles: cfg.maxFiles,
    maxFileSizeKb: cfg.maxFileSizeKb,
    includeDocs: cfg.docExtractionEnabled,
  });
  sendSseEvent(sink, {
    type: "code_graph_phase",
    codeProjectId: cp.id,
    phase: "extracting",
    filesTotal: walked.length,
    filesDone: 0,
  });
  sendSseEvent(sink, {
    type: "code_graph_log",
    codeProjectId: cp.id,
    text: `Found ${walked.length} files (${walked.filter((w) => !w.isDoc).length} source, ${walked.filter((w) => w.isDoc).length} doc).`,
  });

  // ── Extract ─────────────────────────────────────────────────────────────
  const extractions: FileExtraction[] = [];
  const languageHisto: Record<string, number> = {};
  const docBudget = { remaining: cfg.maxDocFiles };
  let done = 0;

  for (const file of walked) {
    if (isAborted()) throw new Error("aborted during extraction");
    done++;
    const lang = langForFile(file.relPath);
    const cacheKey = await computeCacheKey(file, lang);
    if (cacheKey) {
      const cached = readCache(cacheDirs, cacheKey);
      if (cached) {
        extractions.push(cached);
        if (lang) languageHisto[lang] = (languageHisto[lang] ?? 0) + 1;
        if (done % 25 === 0 || done === walked.length) {
          sendSseEvent(sink, {
            type: "code_graph_phase",
            codeProjectId: cp.id,
            phase: "extracting",
            filesTotal: walked.length,
            filesDone: done,
          });
        }
        continue;
      }
    }

    let extraction: FileExtraction;
    try {
      if (file.isDoc) {
        extraction = await extractDocFile(file.relPath, file.absPath, {
          project: cp.project,
          llmCfg: ctx.cfg.llm,
          totalBudget: docBudget,
        });
      } else {
        const text = readFileSync(file.absPath, "utf8");
        extraction = await extractCodeFile(file.relPath, text);
      }
    } catch (e) {
      sendSseEvent(sink, {
        type: "code_graph_log",
        codeProjectId: cp.id,
        text: `skip ${file.relPath}: ${errorMessage(e)}`,
      });
      extraction = { nodes: [], edges: [] };
    }

    extractions.push(extraction);
    if (lang) languageHisto[lang] = (languageHisto[lang] ?? 0) + 1;
    if (cacheKey) writeCache(cacheDirs, cacheKey, extraction);

    if (done % 25 === 0 || done === walked.length) {
      sendSseEvent(sink, {
        type: "code_graph_phase",
        codeProjectId: cp.id,
        phase: "extracting",
        filesTotal: walked.length,
        filesDone: done,
      });
      sendSseEvent(sink, {
        type: "code_graph_log",
        codeProjectId: cp.id,
        text: `extracted ${done}/${walked.length}`,
      });
    }
  }

  // ── Resolve relative-path externals to internal modules ────────────────
  // Without this, `import "./foo"` produces an `external:./foo` stub instead
  // of linking to the actual `src/.../foo.ts#module`. The graph then looks
  // like islands — internal modules never connect to each other. We rewrite
  // edges + drop the orphaned external nodes here so the cluster pass sees
  // real internal structure.
  resolveInternalImports(extractions, walked.map((f) => f.relPath));

  // ── Cluster ─────────────────────────────────────────────────────────────
  if (isAborted()) throw new Error("aborted before clustering");
  setGraphPhase(ctx.db, cp.id, "clustering");
  sendSseEvent(sink, {
    type: "code_graph_phase",
    codeProjectId: cp.id,
    phase: "clustering",
  });
  const graph = buildGraph(extractions);
  const clusterResult = clusterGraph(graph);
  const serialised = serialiseGraph(graph);

  // ── Render ──────────────────────────────────────────────────────────────
  if (isAborted()) throw new Error("aborted before render");
  setGraphPhase(ctx.db, cp.id, "rendering");
  sendSseEvent(sink, {
    type: "code_graph_phase",
    codeProjectId: cp.id,
    phase: "rendering",
  });
  const rendered = renderGraphArtefacts({
    outDirAbs,
    nodes: serialised.nodes,
    edges: serialised.edges,
    clusters: clusterResult.clusters,
    godNodes: clusterResult.godNodes,
    bridgeNodes: clusterResult.bridgeNodes,
    languageHisto,
    docExtractionEnabled: cfg.docExtractionEnabled,
  });

  // ── Report ──────────────────────────────────────────────────────────────
  const reportMd = await generateGraphReport({
    project: cp.project,
    llmCfg: ctx.cfg.llm,
    codeProjectName: cp.name,
    nodes: serialised.nodes,
    edges: serialised.edges,
    clusters: clusterResult.clusters,
    godNodes: clusterResult.godNodes,
    bridgeNodes: clusterResult.bridgeNodes,
  });
  writeGraphReport(rendered.outDir, reportMd);

  return { meta: rendered.meta };
}

/**
 * Resolve a code-project's graph out-dir to a sibling of the cloned repo
 * (under `code/.graph-out/<name>/`) instead of a subdirectory inside the
 * working tree. Keeps the repo clean across re-clones and makes the dir
 * trivial to gitignore globally.
 *
 *   rootAbs:    .../workspace/code/<name>
 *   returns:    .../workspace/code/.graph-out/<name>
 */
export function graphOutDirForRoot(rootAbs: string): string {
  const codeRoot = dirname(rootAbs);
  const name = basename(rootAbs);
  return join(codeRoot, ".graph-out", name);
}

const RESOLVE_EXTENSIONS = [
  "",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".cts",
  ".mjs",
  ".cjs",
] as const;
const RESOLVE_INDEX_FILES = [
  "/index.ts",
  "/index.tsx",
  "/index.js",
  "/index.jsx",
] as const;

/**
 * Rewrite TS/JS relative-path imports (e.g. `external:./foo`) to point at the
 * actual sibling module's id (`src/.../foo.ts#module`) when the target exists
 * in the walked file set. Mutates the extractions in place. Drops the
 * now-orphan external nodes so they don't pollute the graph.
 *
 * Non-relative externals (`external:react`, `external:bun:sqlite`) are left
 * alone — they represent real third-party dependencies and remain as nodes
 * for the "show external imports" toggle on the frontend.
 */
export function resolveInternalImports(
  extractions: FileExtraction[],
  walkedRelPaths: string[],
): void {
  const known = new Set(walkedRelPaths);
  for (const ex of extractions) {
    const sourcePath = ex.nodes.find(
      (n) =>
        n.kind === "module" &&
        n.filePath !== null &&
        !n.id.startsWith("external:"),
    )?.filePath;
    if (!sourcePath) continue;
    const sourceDir = posix.dirname(sourcePath);

    const rewrittenStubs = new Set<string>();
    for (const edge of ex.edges) {
      if (!edge.to.startsWith("external:")) continue;
      const importPath = edge.to.slice("external:".length);
      if (!importPath.startsWith(".") && !importPath.startsWith("/")) continue;
      const resolved = resolveRelativeImport(sourceDir, importPath, known);
      if (!resolved) continue;
      rewrittenStubs.add(edge.to);
      edge.to = `${resolved}#module`;
    }
    if (rewrittenStubs.size > 0) {
      ex.nodes = ex.nodes.filter((n) => !rewrittenStubs.has(n.id));
    }
  }
}

function resolveRelativeImport(
  sourceDir: string,
  importPath: string,
  known: Set<string>,
): string | undefined {
  const base = posix.normalize(posix.join(sourceDir, importPath));
  for (const ext of RESOLVE_EXTENSIONS) {
    if (known.has(`${base}${ext}`)) return `${base}${ext}`;
  }
  for (const idx of RESOLVE_INDEX_FILES) {
    if (known.has(`${base}${idx}`)) return `${base}${idx}`;
  }
  return undefined;
}

async function computeCacheKey(
  file: { absPath: string; isDoc: boolean },
  lang: ReturnType<typeof langForFile>,
): Promise<string | undefined> {
  try {
    const bytes = readFileSync(file.absPath);
    const version = file.isDoc
      ? `doc-v${DOC_EXTRACTOR_VERSION}`
      : lang
        ? `code-${lang}-v${CODE_EXTRACTOR_VERSION}-g${GRAMMAR_VERSIONS[lang]}`
        : `code-unknown-v${CODE_EXTRACTOR_VERSION}`;
    return `${sha256Hex(bytes)}-${version}`;
  } catch {
    return undefined;
  }
}

// Re-exports for tests / callers.
export { readDocText };
