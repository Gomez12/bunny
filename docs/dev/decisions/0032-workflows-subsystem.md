# ADR 0032 — Workflows subsystem

Status: Accepted — 2026-04-21

## Context

Bunny's existing orchestration is ad-hoc: one `runAgent` call per chat turn,
board cards that each run one agent, scheduled tasks that fire one handler
per tick. There is no way to declaratively compose multi-step pipelines that
combine agent prompts, shell commands, loops-until-condition, and human
approval gates — the shape that falls out naturally when a user asks "plan →
implement → run tests → review → approve → open PR".

Archon (https://github.com/coleam00/Archon) popularised this shape as
declarative YAML workflows. The user wants **just the workflow orchestrator**
from Archon, not the agent-harness-builder aspects: take the DAG, reuse
Bunny's existing agents, skills, and tools.

Bunny's hard constraints shape the design:

- **Portable by design.** No new system binaries. `sh`-based bash is
  already assumed (Bun runs on macOS + Linux per CLAUDE.md), so shell
  execution is a trust gate — not a net-new runtime dependency.
- **Append-only schema.** New state goes in new tables; nothing existing
  is altered.
- **Queue-logged mutations.** Every mutation fans out to `events`.
- **TOML over YAML.** Every config in Bunny is TOML (Bun.TOML is built in).
  Adding a YAML parser for one subsystem would be a drift.
- **Single-user-facing security default.** Shell nodes are a real attack
  surface — default off, opt in per install.

## Decision

Introduce a **Workflows subsystem** under `activeTab === "workflows"` in the
"Work" nav group (alongside Chat and Board). Workflows are TOML-defined DAGs
stored on disk at `$BUNNY_HOME/projects/<project>/workflows/<slug>.toml`;
the DB holds a thin index plus run history.

### TOML schema

Four node kinds are dispatched by the engine:

| Kind | Shape | Dispatch |
|---|---|---|
| `prompt` | `prompt = "…"` | one `runAgent` call |
| `bash` | `bash = "…"` | `Bun.spawn` under gates (see below) |
| `loop` | `[nodes.loop] prompt = "…" until = "…"` | iterate runAgent until the literal `<<<until>>>` token appears, max `max_iterations` (default 10) |
| `interactive` | `interactive = true` | stand-alone human approval gate via the existing `ask_user` SSE mechanism |

`depends_on = ["id", …]` declares DAG edges. **v1 is strictly serial** — the
engine walks `computeTopo(def)` in order. Parallel sibling execution is out
of scope (documented below). The parser is hand-rolled in
`src/workflows/schema.ts` (consistent with the rest of Bunny — no zod);
cycle detection is Kahn's algorithm; `parseWorkflowToml` is **reject-on-save**
so the editor never persists invalid state.

### Execution engine

`src/workflows/run_workflow.ts` mirrors `src/board/run_card.ts:runCard`
beat-for-beat: detached async runner, in-memory `Map<runId, fanout>` keyed
by run id, 60 s post-close TTL for late subscribers. The umbrella
`sessionId` hosts all live SSE events; `fresh_context: true` on a loop
iteration mints a new session id (same project) so the agent loses history
between iterations.

**Loop completion** uses a literal string sentinel: the engine appends a
"finish by writing `<<<${until}>>>` on its own line" preamble (see prompt
registry) and scans the final answer. Zero new tools, the signal is
human-readable in the log, and the user's sample TOML needs no changes.

### Bash security — four hard gates

Shell execution is a first-class security boundary. No allowlist in v1;
instead:

1. **Global flag** `[workflows] bash_enabled` in `bunny.config.toml`,
   **default `false`**. Route-level 403 when the workflow contains any
   bash node and the flag is off.
2. **First-run approval per (workflow, nodeId)** — the engine emits an
   `ask_user_question` with the literal command before the first run;
   approval records `sha256(command)` on `workflows.bash_approvals`.
   Editing the command invalidates the approval and re-prompts.
3. **Working directory** = `<projectDir>/workspace/` via
   `safeWorkspacePath(project, ".")`. Trust gate, not a sandbox.
4. **Timeout + output cap** — default 120 s, hard max 600 s;
   stdout+stderr capped at 256 KiB with `…truncated` marker.
   `Bun.spawn` with `AbortController`; SIGKILL on timeout.

Env is stripped to an explicit whitelist (`PATH`, `HOME`, `LANG`, `LC_ALL`,
`BUNNY_HOME`, `BUNNY_PROJECT`) — `LLM_API_KEY` and admin passwords never
leak to spawned processes. Queue logs record `cmdSha`, exit code, duration
— **never the raw command** (it already lives in `workflow_run_nodes.log_text`,
which is scoped to run viewers).

### Interactive gates reuse `ask_user`

Stand-alone `interactive: true` nodes synthesise an `ask_user_question` SSE
event keyed `run:<runId>:node:<nodeId>:approve`, then call `waitForAnswer`
on the umbrella session. Answers post to the existing
`POST /api/sessions/:sessionId/questions/:questionId/answer` route; the
existing `UserQuestionCard` renders. Zero new surface.

### Frontend — React Flow + dagre

`web/src/tabs/workflows/` hosts the tab shell (`WorkflowsTab`), editor
(`WorkflowEditor` with Graph / TOML / Runs tabs), graph view
(`WorkflowGraphView` using `@xyflow/react` + `dagre` vertical layout), and
run view (`WorkflowRunView` with per-node status coloring + log drawer on
click). A browser-side mini TOML parser (`web/src/lib/workflowParser.ts`)
lets the Graph view render live as the user types — the server is still
authoritative on save.

Log source is context-aware: live runs stream through
`/api/workflows/runs/:id/stream` (shared SSE fanout, client filters events
by `nodeId`); historical runs read `workflow_run_nodes.log_text` via
`/api/workflows/runs/:id/nodes/:nodeId/log`.

## Trade-offs considered

- **YAML vs TOML.** The user's sample was YAML; we chose TOML to match every
  other Bunny config. The sample translates one-to-one; no expressiveness
  lost.
- **Parallel DAG execution.** Deferred. v1's strictly-serial walk matches
  the canonical plan → implement → test → review → approve → PR shape and
  keeps SSE/log ordering deterministic. Parallel fan-out is a v2 concern
  when we have a workflow that needs it.
- **Loop stop detection.** Magic-string sentinel beats a dedicated
  `declare_stop_condition` tool: no new closure-bound tool, visible in
  logs, trivial to debug, sample TOML needs no changes.
- **Bash allowlist.** Rejected. Allowlists balloon in scope and mislead
  operators about the actual attack surface. The four-gate model (global
  flag + per-node approval + cwd + timeout) is clearer.
- **Definitions on disk vs in DB.** On disk, mirroring
  `systemprompt.toml` / `prompts.toml`. The DB holds the index + drift
  hash (`toml_sha256`). Editor round-trips are simpler — the UI reads and
  writes the canonical TOML string, the graph view is a derived view.
- **Cron-triggered workflows.** Deferred. The canonical sample ends in
  "create PR" which is manual by nature; adding `cron_expr` and a
  scheduler handler would be premature.

## Consequences

- Shell execution becomes a capability of Bunny — default off, but one
  config flag away from "on". Operators who enable it accept the
  first-run approval gate as their audit trail.
- Four new prompt-registry entries (`workflows.system_prompt`,
  `workflows.loop.preamble`, `workflows.interactive.approval_preamble`,
  `workflows.bash.confirmation_prompt`) join the project-overridable
  set — admins and project owners can tune the framing text.
- `@xyflow/react` and `dagre` are new web dependencies; they ship in the
  Vite bundle under a lazy-loaded `WorkflowsTab` chunk so users who never
  open the tab pay no cost.
- `TrashKind` gains `workflow`, and the web frontend's trash view now
  recognises it (and the pre-existing `code_project`, which had been
  missing).

## Out of scope for v1

- Parallel branch execution.
- Cron-triggered workflows.
- `run_workflow` as an agent tool (sub-workflows / workflow-as-tool).
- Workflow versioning beyond the per-run `toml_snapshot`.
- Remote-agent nodes.
- Bash allowlist / command signing.
- Live human-edit of a running workflow.
- Explicit output-piping between nodes (`{{outputs.plan}}` templating).
