# ADR 0033 — Bun-native code knowledge graph

Status: Accepted — 2026-04-21

## Context

The Code sub-app (ADR 0030) already lets users clone a public repo into
`<projectDir>/workspace/code/<name>/` and browse it through two features on
the secondary icon rail (**Show Code**, **Chat**). Users asked for a third
feature that produces a [graphify](https://github.com/safishamsi/graphify)-style
knowledge graph of the cloned repo — nodes for modules / functions / classes,
edges for imports and semantic mentions, clustered into communities and
visualised in-app.

Graphify itself is a Python CLI (`graphifyy` on PyPI). Calling it as a
subprocess would break the portable-binary contract — the very reason
ADR 0030 uses `isomorphic-git` instead of a system `git`. We therefore port
the core pipeline to Bun so the feature ships inside the same compiled
binary.

## Decision

Ship the graph pipeline in **Bun / TypeScript**, inside `src/code/graph/`.
Scope is **code + docs**: tree-sitter AST extraction for the ten most common
source languages, optional LLM-subagent extraction for Markdown / PDF /
DOCX. Graphify's audio/video layer is out of scope — A/V files are rare in
a source repo and the Python ecosystem (`faster-whisper`, `graspologic`)
is poorly suited to a JS port.

### Pipeline

```
walk → extract per-file (cache) → build graphology Graph
      → Louvain clustering → render graph.json + meta.json → LLM report
```

Each phase is a module under `src/code/graph/`:

- **`walk.ts`** — tree walk honouring a root-level `.gitignore` plus a fixed
  always-ignore set (`node_modules`, `.git`, `dist`, `target`, …); caps both
  file count and per-file size.
- **`grammars.ts`** — lazy tree-sitter loader. All 11 grammar WASMs ship in
  the portable binary via `import "…wasm" with { type: "file" }`, pulled
  from the pre-built `tree-sitter-wasms` package (TypeScript, TSX,
  JavaScript, Python, Go, Rust, Java, C, C++, Ruby, PHP). Grammar load
  failures degrade that language to module-only extraction rather than
  aborting the run.
- **`extract/code.ts`** — per-language AST walkers. Four full walkers
  (TS/JS/TSX, Python, Go, Rust) emit module + function + class + method
  nodes plus `imports` edges with `confidence = 1.0`. The remaining
  languages (Java, C, C++, Ruby, PHP) use a module-only fallback to keep
  graph coverage graceful.
- **`extract/docs.ts`** — off-by-default LLM pass. Reads `.md`, `.pdf`
  (via `pdfjs-dist`), `.docx` (via `mammoth`), calls the
  `code.graph.doc_extract` prompt, parses the fenced JSON, returns a
  `FileExtraction` with `confidence < 1.0` so AST edges dominate when they
  overlap.
- **`cache.ts`** — per-file SHA256 cache under
  `<outDir>/cache/<hash>-<version>.json`. Re-runs skip unchanged
  files, matching graphify's incremental behaviour. The out-dir is a
  sibling of the cloned repo (see Storage), not inside it.
- **`build.ts`** — merges the per-file extractions into one `graphology`
  undirected graph, deduplicating nodes by id and summing edge confidence.
- **`cluster.ts`** — wraps `graphology-communities-louvain`. Emits
  `cluster: number` on every node plus top-N god / bridge nodes via
  `graphology-metrics` betweenness centrality (skipped past 2000 nodes —
  falls back to degree for performance).
- **`render.ts`** — writes `graph.json` and `meta.json` into the
  out-dir (see Storage). No HTML template — rendering is client-side.
- **`report.ts`** — single `chatSync` call with the `code.graph.report`
  prompt. Deterministic fallback when the LLM key is not configured.
- **`run.ts`** — detached orchestrator. Mirrors `src/code/clone.ts`:
  race-safe claim via `setGraphPhase('extracting')`, AbortController
  timeout, SSE fanout sink, try/finally so the row never gets stuck on a
  mid-flight phase.

### Storage

Five new columns on `code_projects` (append-only, ADR 0030 invariant):

```
graph_status     TEXT NOT NULL DEFAULT 'idle'  -- idle|extracting|clustering|rendering|ready|error
graph_error      TEXT
graph_node_count INTEGER
graph_edge_count INTEGER
last_graphed_at  INTEGER
```

Artefacts (`graph.json`, `meta.json`, `GRAPH_REPORT.md`, `cache/`) live at
`<projectDir>/workspace/code/.graph-out/<name>/` — a sibling of the cloned
repo, **not** inside it. Keeping graph state out of the working tree means
re-clones don't fight with our scratch state, the dir doesn't pollute
`git status`, and editor "untracked" indicators stay quiet. The path is
computed once by `graphOutDirForRoot(rootAbs)` and threaded through the
pipeline. A legacy in-repo `graph-out/` from earlier versions is wiped
on the next run.

### Routes

Auth: `canEditCodeProject` for mutation, `canSeeProject` for reads.

- `POST /api/code/:id/graph/run` — kick off + SSE stream via the new
  `graphFanouts` registry. Returns 409 when a run is already claimed, 503
  when `[code.graph] enabled = false`.
- `GET /api/code/:id/graph/stream` — late subscribe to the live fanout
  (60 s post-close TTL).
- `GET /api/code/:id/graph/data` — returns the run's `graph.json`.
- `GET /api/code/:id/graph/report` — returns the run's `GRAPH_REPORT.md`.

### Frontend

- Third feature button **Graph** on `CodeRail.tsx` (`Network` icon from
  the barrel).
- New view `web/src/tabs/code/CodeGraphView.tsx` (~400 LOC):
  - Status chip driven by a 2 s poll against `GET /api/code/:id`.
  - Live `<pre>` log pane fed by SSE `code_graph_log` events.
  - When ready: xyflow + dagre render with cluster-coloured nodes, capped
    at `displayMaxNodes` (default 300) — large graphs show top-degree
    members per cluster plus all god / bridge hubs.
  - **Report** tab renders `GRAPH_REPORT.md` via the existing
    `react-markdown` + `remark-gfm` stack.
- Four new SSE event shapes in `src/agent/sse_events.ts`
  (`code_graph_run_started`, `code_graph_phase`, `code_graph_log`,
  `code_graph_run_finished`).

## Alternatives considered

- **Shell out to `graphifyy`.** Matches graphify feature-for-feature (A/V
  included) but requires Python + `uv` / `pipx` on the host. Breaks the
  portable-binary contract that ADR 0030 spent real effort preserving.
  Rejected.
- **MCP stdio server (`python -m graphify.serve …`).** Converts graphify
  into a long-lived subprocess exposing tool calls. Same Python prerequisite
  as above plus a new lifecycle surface. Rejected.
- **Leiden clustering.** The Leiden algorithm is sharper than Louvain on
  tightly-connected graphs. `graphology-communities-leiden` does not exist
  on npm and the only JS Leiden port (`ngraph.leiden`, ~44 weekly
  downloads) sits outside the graphology ecosystem — not worth the
  integration risk. The `[code.graph] clusterAlgorithm` config hook is
  kept so a future swap is trivial.
- **Whisper-based A/V extraction.** `@xenova/transformers.js` Whisper
  works on Bun but adds a ~500 MB first-run model download and runs much
  slower than CPython + faster-whisper. Deferred.
- **iframe `graph.html`.** Graphify's bundled vis.js HTML is polished and
  graph-library-grade, but iframing it would split styling, keyboard
  handling, and export from the rest of the app. Rendering in-app with
  xyflow (already a dep for the Workflows tab) keeps the surface consistent.

## Consequences

- **Binary size.** The `tree-sitter-wasms` bundle adds ~30-50 MiB to the
  portable binary — roughly double today's size. This is the explicit cost
  of keeping the graph feature toolchain-free.
- **No mandatory LLM.** Code-only runs are deterministic (AST walk +
  Louvain) and cost nothing. Doc extraction defaults **off**
  (`cfg.code.graph.docExtractionEnabled = false`). v1 ships as a
  config-only flag with no per-run UI toggle; once a per-run toggle is
  added the UI should render a "will issue up to N LLM calls"
  disclaimer before firing the run.
- **Coverage gap.** Java / C / C++ / Ruby / PHP files produce
  module-only nodes in v1. Real AST walkers can be added in a follow-up
  without data-model changes.
- **Deps added.** `web-tree-sitter@0.22.6` (pairs with
  `tree-sitter-wasms@0.1.13`'s dylink-v1 format), `tree-sitter-wasms`,
  `graphology`, `graphology-communities-louvain`, `graphology-metrics`,
  `pdfjs-dist`, `mammoth`.
- **New prompt-registry keys.** `code.graph.doc_extract` (JSON contract)
  and `code.graph.report`. Both are `projectOverridable` and live in the
  standard registry snapshot test.
- **Append-only schema.** Five new columns on `code_projects`; no renames
  or drops. Soft-delete behaviour is unchanged.
- **Future work.** Leiden clustering, drill-down-by-cluster view, AST
  walkers for Java / C / C++ / Ruby / PHP, an agent-facing
  `read_code_graph` tool that answers "what depends on X?" from
  `graph.json`.
