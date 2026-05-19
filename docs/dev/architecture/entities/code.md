# Code (sub-application)

## What it is

Per-Bunny-project source-code areas, the first subsystem to own a **secondary 56 px icon rail** (the pattern is reusable for future sub-apps). Each `code_project` is a slug-named directory under `<projectDir>/workspace/code/<name>/`, optionally seeded from a public git URL via `isomorphic-git` (no system `git` binary — preserves the portable-binary contract). v1.1 ships three features behind the rail:

- **Show Code** — file tree + details + quick-edit composer.
- **Chat** — persistent per-code-project conversation, SSE-streamed, scoped to the workspace tools.
- **Graph** — Bun-native code-graph extraction (tree-sitter AST for ten programming languages plus optional LLM-subagent extraction for MD/PDF/DOCX) with Louvain clustering and an in-app `@xyflow/react` + `dagre` view.

See [ADR 0030](../../adr/0030-code-sub-application.md) for the sub-app shape and [ADR 0033](../../adr/0033-bun-native-code-graph.md) for the graph subsystem.

## Data model

```sql
CREATE TABLE code_projects (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  project           TEXT    NOT NULL,
  name              TEXT    NOT NULL,                 -- slug, doubles as directory name
  description       TEXT    NOT NULL DEFAULT '',
  git_url           TEXT,                             -- NULL = local-only scratch area
  git_ref           TEXT,                             -- branch/tag/ref; NULL = remote HEAD
  git_status        TEXT    NOT NULL DEFAULT 'idle',  -- 'idle' | 'cloning' | 'ready' | 'error'
  git_error         TEXT,
  last_cloned_at    INTEGER,
  graph_status      TEXT    NOT NULL DEFAULT 'idle',  -- 'idle' | 'extracting' | 'clustering' | 'rendering' | 'ready' | 'error'
  graph_error       TEXT,
  graph_node_count  INTEGER,
  graph_edge_count  INTEGER,
  last_graphed_at   INTEGER,
  created_by        TEXT    REFERENCES users(id) ON DELETE SET NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  deleted_at        INTEGER,                          -- non-null = trash
  deleted_by        TEXT,
  UNIQUE(project, name)
);
```

Key invariants:

- **`UNIQUE(project, name)`** — slug doubles as directory name; soft-delete renames to `__trash:<id>:<name>` so the slot stays free for re-creation.
- **No translation sidecars.** Code is not natural language; the entity is registered with trash but not with `translatable.ts`.
- **Append-only.** Five graph columns were added on top of the v1 row; new states grow the column set, never alter it.
- **`code/` is a protected workspace root** (widened `WORKSPACE_DEFAULT_SUBDIRS` in `src/tools/workspace.ts`). Contents are freely editable; the root itself cannot be moved or deleted.

## HTTP API

CRUD + features (mounted in `src/server/code_routes.ts`):

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/projects/:project/code` | list code projects in a Bunny project |
| `POST` | `/api/projects/:project/code` | `{ name, description?, gitUrl?, gitRef? }` |
| `GET` | `/api/code/:id` | single row + `graphSummary` |
| `PATCH` | `/api/code/:id` | `{ description?, gitRef? }` |
| `DELETE` | `/api/code/:id` | soft-delete |
| `POST` | `/api/code/:id/clone` | detached clone, returns immediately with `git_status='cloning'` |
| `GET` | `/api/code/:id/tree?path=…` | workspace listing |
| `GET` | `/api/code/:id/file?path=…&encoding=utf8\|base64\|raw` | workspace read |
| `POST` | `/api/code/:id/ask` | seeds a normal Chat session, returns `{ sessionId }` |
| `POST` | `/api/code/:id/edit` | SSE; `systemPromptOverride = resolvePrompt("code.edit")` |
| `POST` | `/api/code/:id/chat` | SSE; persistent session via `X-Session-Id`, `localStorage["bunny.codeChatSession.<id>"]` |
| `POST` | `/api/code/:id/graph/run` | SSE start; 409 if already running |
| `GET` | `/api/code/:id/graph/stream` | re-attach to in-flight run via `subscribeFanout(graphFanouts, id, sink)` |
| `GET` | `/api/code/:id/graph/data` | last `graph.json` |
| `GET` | `/api/code/:id/graph/report` | last `GRAPH_REPORT.md` |

`/edit` and `/chat` always run with **`askUserEnabled = false` and `mentionsEnabled = false`** — this is a background-renderer-style entry point. `webCfg` is passed so the agent can web-fetch alongside workspace tools.

URL scheme is validated at the route boundary: `ssh://`, `user@host:path`, `file://`, `ext::` are rejected with 400. Public-repo only in v1; no credential callback exists on the http transport.

## Code paths

- `src/server/code_routes.ts` — all routes above.
- `src/memory/code_projects.ts` — CRUD + `canSeeCodeProject` / `canEditCodeProject`.
- `src/code/clone.ts` — `isomorphic-git`-based clone with `AbortController` (timeout) and post-clone size cap. Bounded by `cfg.code.cloneTimeoutMs`, `cfg.code.defaultCloneDepth`, `cfg.code.maxRepoSizeMb`.
- `src/code/graph/run.ts` — graph orchestrator. Owns `graphFanouts` (in-memory `Map<id, Fanout>` mirroring `run_card.ts` / `run_topic.ts` / `run_workflow.ts`).
- `src/code/graph/walk.ts` — file walker honoring `cfg.code.graph.maxFiles`, `cfg.code.graph.maxFileSizeKb`, `cfg.code.graph.maxDocFiles`, `cfg.code.graph.languages`.
- `src/code/graph/extract/` — per-language tree-sitter extractors (via `tree-sitter-wasms` + `web-tree-sitter@0.22.6`).
- `src/code/graph/cluster.ts` — Louvain via `graphology-communities-louvain`.
- `src/code/graph/build.ts` / `render.ts` / `report.ts` — final `graph.json` + `GRAPH_REPORT.md` writers (placed in `code/.graph-out/<name>/`, *beside* the clone, not inside it).
- `src/code/graph/cache.ts` — content-addressed cache so unchanged files skip re-extraction.

Three prompt-registry entries (`code.ask`, `code.chat`, `code.edit`) plus two graph entries (`code.graph.doc_extract` JSON contract, `code.graph.report`) — all `projectOverridable`. Variables: `{{codeProjectName}}`, `{{codeProjectPath}}`, `{{fileListing}}`, `{{question}}`, `{{instruction}}`.

## UI

- `web/src/tabs/CodeTab.tsx` — sub-app shell. Renders the secondary rail + the active feature pane.
- `web/src/components/CodeRail.tsx` — secondary 56→240 px rail. Top: `CodeProjectPickerDialog`. Bottom: feature buttons (disabled until a project is picked).
- `web/src/components/CodeProjectDialog.tsx` — create / edit modal.
- `web/src/tabs/code/CodeShowCodeView.tsx` — file tree + viewer + quick-edit composer.
- `web/src/tabs/code/CodeChatView.tsx` — persistent chat. Reuses `useSSEChat` (with the same chronological items + sticky-bottom autoscroll machinery as the main Chat tab — see [`chat.md`](./chat.md)).
- `web/src/tabs/code/CodeGraphView.tsx` — graph runner + `@xyflow/react`/`dagre` viewer; honours `cfg.code.graph.displayMaxNodes`.

`localStorage` keys:

- `bunny.activeCodeProject.<project>` — selected code-project per Bunny project.
- `bunny.activeCodeFeature` — `show` / `chat` / `graph`.
- `bunny.codeChatSession.<codeId>` — persistent chat session id per code-project.

## Extension hooks

- **Trash:** yes — registered via `registerTrashable({...})` like documents/whiteboards/contacts/kb_definitions/workflows. Soft-delete renames + `code/<name>/` is left on disk (cleanup is a separate hard-delete concern). See [ADR 0025](../../adr/0025-soft-delete-and-trash.md).
- **Translation:** no.
- **Notifications:** v1 = no `@user`-mention surface (`/edit` and `/chat` set `mentionsEnabled = false`).
- **Scheduler:** v1 = no auto-run (graph runs are user-triggered). Adding a scheduled re-graph would be a `HandlerRegistry` registration in `src/code/graph/`.
- **Agent tools:** workspace tools (`list_workspace_files` / `read_workspace_file` / `write_workspace_file`) are auto-spliced by `buildRunRegistry` for `/edit` and `/chat`; the workspace path is rooted at `code/<name>/`. `webCfg` is passed so `web_fetch` / `web_search` / `web_download` are also available.

## Key flows

### Clone

```
POST /api/projects/:project/code  { name, gitUrl?, gitRef? }
  → INSERT row with git_status='idle' (and git_status='cloning' if gitUrl is set)
  → return immediately
POST /api/code/:id/clone                 (or auto-fired on creation)
  → detached job: isomorphic-git → AbortController-bounded → size-cap check
  → success: git_status='ready', last_cloned_at = now
  → failure: git_status='error', git_error = message, directory wiped
Frontend polls GET /api/code/:id every 2 s for the transition.
```

### Edit / Chat

```
POST /api/code/:id/edit  { instruction }
POST /api/code/:id/chat  { sessionId?, prompt }
  → runAgent({
      systemPromptOverride: resolvePrompt("code.edit" | "code.chat", {project}),
      askUserEnabled: false,
      mentionsEnabled: false,
      webCfg, workspaceCfg
    })
  → SSE frames stream back via createSseRenderer
  → /chat returns the session id in X-Session-Id; persisted in localStorage
```

### Graph run

```
POST /api/code/:id/graph/run
  → claim row (graph_status: idle → extracting); 409 if already running
  → walk(maxFiles, maxFileSizeKb, languages) → tree-sitter extract per file
  → optional LLM doc-extract for MD/PDF/DOCX (cfg.code.graph.docExtractionEnabled, false by default)
  → cluster (Louvain) → render → report
  → write graph.json + GRAPH_REPORT.md to code/.graph-out/<name>/
  → graph_status='ready'; graph_node_count / graph_edge_count populated
SSE: code_graph_run_started, code_graph_run_phase, code_graph_run_log, code_graph_run_finished
Re-attach via GET /api/code/:id/graph/stream — replays from the in-memory fanout (60 s post-close TTL).
```

## Gotchas

- **No `git` binary.** Clones are bounded by `cloneTimeoutMs` because pure-JS clones can hang on slow remotes; the `AbortController` is wired into the `http` transport, so the timeout is load-bearing even for misbehaving servers.
- **Soft-delete leaves the directory.** A re-created project with the same slug after restore will land on the existing tree (intentional — preserves history). Hard-delete is the correct path to also wipe the directory.
- **Binary size.** The grammar WASMs from `tree-sitter-wasms` add ~30–50 MiB to the standalone binary. Documented trade-off for toolchain-free portability.
- **Document extraction is opt-in.** `cfg.code.graph.docExtractionEnabled` defaults to `false` because it costs LLM calls; v1 is config-only with no per-run UI toggle.
- **`code/` is protected.** Like `input/` and `output/`, deleting or moving the root itself fails; only the contents are mutable. This is enforced by `safeWorkspacePath` deriving `PROTECTED_ROOTS` from `WORKSPACE_DEFAULT_SUBDIRS`.
- **`/chat` and `/edit` deliberately disable `ask_user`.** Background renderer pattern — neither path can surface a question card. If you need interactive prompts in a code surface, route the user back to the main Chat tab via `/api/code/:id/ask`.

## Related

- [ADR 0030 — Code sub-application with a secondary icon rail](../../adr/0030-code-sub-application.md)
- [ADR 0033 — Bun-native code graph](../../adr/0033-bun-native-code-graph.md)
- [ADR 0025 — Soft-delete and trash](../../adr/0025-soft-delete-and-trash.md)
- [ADR 0029 — Prompt registry and two-tier overrides](../../adr/0029-prompt-registry-and-two-tier-overrides.md)
- [`./chat.md`](./chat.md) — chronological items timeline + sticky-bottom autoscroll, shared by `CodeChatView`.
- [`./files.md`](./files.md) — workspace tools + `safeWorkspacePath`.
- [`./workflows.md`](./workflows.md) — sibling subsystem with the same detached-runner + fanout pattern.
