# Workflows

## What it is

Per-project TOML-defined DAG pipelines. Each node is exactly one of `prompt`,
`bash`, `loop`, or `interactive` — the engine dispatches in topological order
and streams per-node SSE events through an umbrella session. The graphical
editor uses `@xyflow/react` with `dagre` vertical auto-layout; run view adds
status coloring per node and a per-node log drawer on click.

See [ADR 0032](../../adr/0032-workflows-subsystem.md) for the decision log
and rationale.

## Data model

```sql
CREATE TABLE workflows (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project         TEXT    NOT NULL,
  slug            TEXT    NOT NULL,               -- filename stem, immutable
  name            TEXT    NOT NULL,
  description     TEXT,
  toml_sha256     TEXT    NOT NULL,               -- detects on-disk drift
  layout_json     TEXT,                           -- xyflow node x/y positions
  bash_approvals  TEXT,                           -- JSON map nodeId -> sha256(cmd)
  created_by      TEXT    REFERENCES users(id) ON DELETE SET NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  deleted_at      INTEGER,                        -- trash marker
  deleted_by      TEXT,
  UNIQUE(project, slug)
);

CREATE TABLE workflow_runs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id    INTEGER NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  project        TEXT    NOT NULL,
  session_id     TEXT    NOT NULL,
  status         TEXT    NOT NULL,                -- queued|running|done|error|cancelled|paused
  trigger_kind   TEXT    NOT NULL DEFAULT 'manual',
  triggered_by   TEXT    REFERENCES users(id) ON DELETE SET NULL,
  started_at     INTEGER NOT NULL,
  finished_at    INTEGER,
  error          TEXT,
  toml_snapshot  TEXT    NOT NULL                 -- frozen def at run start
);

CREATE TABLE workflow_run_nodes (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id            INTEGER NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  node_id           TEXT    NOT NULL,
  kind              TEXT    NOT NULL,
  status            TEXT    NOT NULL,
  iteration         INTEGER NOT NULL DEFAULT 0,   -- 0 = non-loop; monotonic per loop
  child_session_id  TEXT,
  started_at        INTEGER,
  finished_at       INTEGER,
  result_text       TEXT,                         -- final answer / bash tail / answer
  log_text          TEXT,                         -- concatenated per-node log
  error             TEXT,
  UNIQUE(run_id, node_id, iteration)
);
```

On-disk asset: `<projectDir>/workflows/<slug>.toml` via
`src/memory/workflow_assets.ts`.

## TOML shape

```toml
name = "build feature"
description = "Canonical plan → implement → review pipeline."

[[nodes]]
id = "plan"
prompt = "Explore and draft a plan."

[[nodes]]
id = "implement"
depends_on = ["plan"]

[nodes.loop]
prompt = "Implement next task; run validation."
until = "ALL_TASKS_COMPLETE"
fresh_context = true
max_iterations = 10

[[nodes]]
id = "run-tests"
depends_on = ["implement"]
bash = "bun run validate"

[[nodes]]
id = "approve"
depends_on = ["run-tests"]
interactive = true

[[nodes]]
id = "create-pr"
depends_on = ["approve"]
prompt = "Push changes and create a PR."
```

Parse rules (`src/workflows/schema.ts`):

- Node id: `/^[a-z0-9][a-z0-9_-]{0,63}$/`, unique.
- Exactly one of `{prompt, bash, loop}` OR stand-alone `interactive = true`.
- `depends_on` ids must exist; self-loops rejected.
- No cycles (Kahn's algorithm).
- Loop `until` is non-empty; `max_iterations` in `[1, 100]`.

`POST /api/workflows` + `PUT /api/workflows/:id` return **400 with structured
errors** on validation failure — the editor never persists an invalid state.

## Execution

`src/workflows/run_workflow.ts` mirrors `src/board/run_card.ts`:

- Run returns `{ run, sessionId }` immediately; detached task runs the engine.
- In-memory `Map<runId, fanout>` streams SSE to every subscriber on
  `GET /api/workflows/runs/:id/stream`; 60 s TTL after run close for late
  subscribers (same shape as board cards).
- Topological order via `computeTopo(def)`. **v1 is strictly serial.**
- Per-node dispatch:
  - **prompt** → `runAgent` with `systemPromptOverride` composed from
    `resolvePrompt("workflows.system_prompt", { project })`.
  - **bash** → `executeBash` (see gates below).
  - **loop** → iterate `runAgent` up to `max_iterations`, check the final
    answer for `<<<${until}>>>`.
  - **interactive** → emit `ask_user_question` SSE, `waitForAnswer` on the
    umbrella session.

Errors bail the run and mark the failing node. Cancel is cooperative via
`requestCancelWorkflowRun(runId)` — the engine polls `fan.cancelRequested`
between nodes and cancels any pending user-question waiter.

## Bash security

Not a tool — called directly by the engine. Four hard gates:

1. **Global flag** `[workflows] bash_enabled` in `bunny.config.toml`
   (default `false`). Route-level 403 at `POST /api/workflows/:id/run`.
2. **First-run approval per (workflow, nodeId)** — engine emits
   `ask_user_question` with the literal command; approval records
   `sha256(command)` on `workflows.bash_approvals`. Command edits
   invalidate and re-prompt.
3. **cwd** = `<projectDir>/workspace/` via `safeWorkspacePath`.
4. **Timeout + output cap** — 120 s default, 600 s hard max; 256 KiB
   output cap. `Bun.spawn` + `AbortController` + `SIGKILL` on timeout.

Env whitelist: `PATH`, `HOME`, `LANG`, `LC_ALL`, `BUNNY_HOME`,
`BUNNY_PROJECT`. API keys are never inherited.

## Prompt registry

Four entries live under `src/prompts/registry.ts`:

| Key | Scope | Variables |
|---|---|---|
| `workflows.system_prompt` | projectOverridable | `workflowName`, `nodeId`, `nodeKind` |
| `workflows.loop.preamble` | projectOverridable | `stopToken`, `iteration`, `maxIterations`, `until` |
| `workflows.interactive.approval_preamble` | projectOverridable | `priorResults` |
| `workflows.bash.confirmation_prompt` | global | `command`, `nodeId` |

Snapshot fixtures under `tests/prompts/fixtures/workflows__*.txt` guard
against accidental drift.

## HTTP routes

All mounted via `src/server/workflow_routes.ts`. Permissions: `canSeeProject`
for reads, `canEditProject` for writes and runs.

| Method | Path | Notes |
|---:|---|---|
| GET | `/api/projects/:project/workflows` | list non-deleted |
| POST | `/api/projects/:project/workflows` | `{ slug?, tomlText, layout? }` |
| GET | `/api/workflows/:id` | `{ workflow, tomlText }` |
| PUT | `/api/workflows/:id` | `{ tomlText?, layout? }` |
| DELETE | `/api/workflows/:id` | soft-delete via `src/memory/trash.ts` |
| POST | `/api/workflows/:id/run` | returns `{ run, sessionId }` immediately |
| POST | `/api/workflows/runs/:runId/cancel` | cooperative |
| GET | `/api/workflows/:id/runs?limit=50` | run history |
| GET | `/api/workflows/runs/:runId` | `{ run, nodes[] }` |
| GET | `/api/workflows/runs/:runId/stream` | SSE, 60 s late-subscriber window |
| GET | `/api/workflows/runs/:runId/nodes/:nodeId/log` | historical log |

Ask-user answers reuse the existing
`POST /api/sessions/:sessionId/questions/:questionId/answer` route.

## Queue topic

Topic: `workflows`. Kinds: `create`, `update`, `delete`, `restore`,
`run.start`, `run.node.start`, `run.node.finish`, `run.finish`,
`run.error`, `run.cancel`, `bash.execute`, `bash.approval.granted`. Raw
bash commands are never logged — only `cmdSha`.

## Frontend

- `web/src/tabs/WorkflowsTab.tsx` — list + new-workflow button.
- `web/src/tabs/workflows/WorkflowEditor.tsx` — tabs (Graph / TOML / Runs)
  with a debounced autosave on TOML edits.
- `web/src/tabs/workflows/WorkflowGraphView.tsx` — `@xyflow/react` +
  `dagre` rankdir `TB`; read-only node positioning in v1.
- `web/src/tabs/workflows/WorkflowRunView.tsx` — same graph with
  per-node status coloring, `ask_user_question` dialog, and a right-side
  log drawer on click. Live runs stream via
  `/api/workflows/runs/:id/stream`; historical nodes read via
  `/api/workflows/runs/:id/nodes/:nodeId/log`.
- `web/src/lib/workflowParser.ts` — browser-side mini TOML parser scoped
  to the workflow DSL. Server is still authoritative on save.

localStorage keys: `bunny.activeWorkflow.<project>`,
`bunny.workflowEditor.view.<workflowId>`.

## Tests

Under `tests/workflows/` and `tests/trash/workflows.test.ts`:

- `parse.test.ts` — valid sample round-trips; 8 malformed-TOML fixtures
  each produce the expected structured error.
- `run_workflow.test.ts` — mocks `runAgent` via the `runAgentImpl` seam
  on `RunWorkflowOpts`. Covers serial prompt progression, loop
  stop-token detection, loop-max-iteration exhaustion, interactive gate
  resolution, bash-disabled rejection.
- `bash_exec.test.ts` — real `Bun.spawn`: output truncation, timeout,
  env stripping, `BUNNY_PROJECT` export, workspace cwd.
- `trash/workflows.test.ts` — soft-delete + restore + name_conflict +
  hard-delete.
- `tests/prompts/registry_defaults.test.ts` — snapshots the four new
  prompt-default texts.
