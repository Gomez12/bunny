# ADR 0009 — Agents

## Context

Projects group conversations and offer a per-project base prompt, but every
turn inside a project is answered by one generic assistant with the full
tool registry. A user-facing need emerged to model **named personalities**
with:

- their own system prompt + description,
- a limited tool-set,
- per-agent memory knobs (context window, recall size),
- a "knows about peers" switch,
- a "can be called as subagent" switch + per-agent allowlist of callable
  subagents (orchestrator/worker patterns),
- invocation from a normal chat by prefixing `@name` to a message,
- a clear UI signal that a response came from a specific agent rather than
  the default assistant.

## Decision

Introduce a first-class **Agent** concept that lives next to Project but
stays orthogonal to it.

### Scope & availability

- Agents are **global** at the database level (name is a PK, same shape as
  project names: `^[a-z0-9][a-z0-9_-]{0,62}$`).
- A new `project_agents(project, agent)` join table declares which agents
  are **available** in which project. A chat can only mention agents that
  are linked to the session's project.

### On-disk layout

- `$BUNNY_HOME/agents/<name>/config.toml` — mirrors the project
  `systemprompt.toml` pattern but also carries `tools = [...]` (whitelist),
  `allowed_subagents = [...]`, and per-agent `last_n`/`recall_k` overrides.
- DB holds only metadata: name, description, visibility, `is_subagent`,
  `knows_other_agents`, `context_scope`, audit columns.

### Message plumbing

- `messages` gets an `author` column. `NULL` = default assistant / user
  row; `"bob"` = written by agent Bob. All `insertMessage` calls inside the
  loop stamp the column when an agent is active.
- `getRecentTurns`, `searchBM25`, `searchVector`, and `hybridRecall` grow an
  optional `ownAuthor` filter used when an agent has
  `context_scope = "own"`. User turns always pass the filter so the agent
  still sees what was asked.

### Agent loop

- `runAgent` accepts `agent?: string` and `callDepth?: number`.
- When set, it resolves `loadAgentAssets(agent)`, merges memory knobs with
  precedence `agent → project → global`, filters the tool registry via
  `ToolRegistry.subset(filter, extras)`, and builds a system message via the
  extended `buildSystemMessage` (agent prompt wins over project; `otherAgents`
  appended when `knows_other_agents` is true).
- Subagent invocation is exposed as the built-in `call_agent(name, prompt)`
  tool, injected only when `allowed_subagents` is non-empty. The handler
  starts a nested `runAgent` with a silent renderer so only the final answer
  reaches the UI, stamps `author`, and refuses to recurse past
  `MAX_AGENT_CALL_DEPTH` (2).

### @mention semantics

- `parseMention` strips a leading `@name` (with regex-level validation) off
  the user prompt. `POST /api/chat` honours an explicit `agent` body field
  first; otherwise it calls the parser. An agent mention without a trailing
  prompt returns 400.
- When resolved, the agent **replaces** the default assistant for that turn
  — there is no fallback chain. The user sees a single response, authored by
  the agent.

### UI surface

- "Agents" tab (after Projects in the nav) mirrors "Projects": card grid with New/edit/delete and
  per-card project-availability checkboxes.
- SSE events (`content`, `reasoning`, `tool_call`, `tool_result`, `turn_end`)
  carry an optional `author`. The web `MessageBubble` renders `@name` in the
  role slot and a distinct accent when `author` is set. Historical messages
  propagate `author` through `StoredMessage` → `HistoryTurn`.

## Alternatives considered

- **Per-project agents** — simpler isolation but forces duplication and makes
  a shared "researcher" impossible. Rejected in favour of the opt-in join.
- **@mention as additive turn** (assistant answers, then agent answers) —
  double the tokens and ambiguous attribution. Rejected.
- **Subagent invocation via intercepted @mentions in assistant output** —
  creative but hard to control (loops, token budget). Rejected in favour of
  the explicit `call_agent` tool.

## Consequences

- The loop is slightly heavier (agent-asset loading, per-run registry) but
  stays single-orchestrator — no hidden control flow.
- Schema stays append-only (`messages.author`, two new tables).
- Client and server share the `author` field through the existing
  `sse_events.ts` contract; no drift possible.
- Explicit out-of-scope for now: inline (non-leading) `@mention` parsing,
  per-agent ACLs beyond the project ACL, nested streaming of subagent output
  into the UI (only the final string is surfaced as the tool result).
