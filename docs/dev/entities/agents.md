# Agents

## What it is

Named personalities with their own system prompt, tool whitelist, and memory knobs. Orthogonal to projects: the agent definition is global, per-project availability is controlled via a join table.

Mention an agent in chat with `@name` — it replaces the default assistant for that turn. Agents can also be sub-agents, callable via the built-in `call_agent` tool.

## Data model

```sql
CREATE TABLE agents (
  name                TEXT    PRIMARY KEY,
  description         TEXT    NOT NULL DEFAULT '',
  visibility          TEXT    NOT NULL DEFAULT 'private',
  is_subagent         INTEGER NOT NULL DEFAULT 0,
  knows_other_agents  INTEGER NOT NULL DEFAULT 0,
  context_scope       TEXT    NOT NULL DEFAULT 'full',     -- 'full' | 'own'
  created_by          TEXT    REFERENCES users(id) ON DELETE SET NULL,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE TABLE project_agents (
  project  TEXT NOT NULL,
  agent    TEXT NOT NULL,
  PRIMARY KEY (project, agent)
);
```

On-disk config: `$BUNNY_HOME/agents/<name>/config.toml` — holds the system prompt, tool whitelist (`tools = [...]`), memory knobs (`last_n`, `recall_k`), and `allowed_subagents`.

`messages.author` is the responding agent's name. New turns are never NULL — the `/api/chat` route falls back to the configured default agent (see "Default agent" below). Legacy NULL rows remain in history and re-label at render time. Append-only.

## HTTP API

- `GET /api/agents` — list. Non-admin sees own + public.
- `POST /api/agents` — create.
- `GET/PATCH/DELETE /api/agents/:name` — CRUD.
- `GET /api/projects/:name/agents` — list linked agents.
- `POST /api/projects/:name/agents` — link.
- `DELETE /api/projects/:name/agents/:agent` — unlink.
- `GET /api/tools` — list every tool (for the picker). Includes dynamic tool names.

## Code paths

- `src/memory/agents.ts` — CRUD + link helpers.
- `src/memory/agent_assets.ts` — TOML loader + mtime cache.
- `src/tools/call_agent.ts` — subagent-invocation tool (closure-bound per run).
- `src/agent/loop.ts:runAgent` — reads `agent` option, merges memory knobs (agent → project → global), calls `ToolRegistry.subset(filter, extras)`.
- `src/agent/prompt.ts:buildSystemMessage` — agent prompt wins over project prompt (default `append = false`).
- `src/agent/mention.ts:parseMention` — strips leading `@name`; only when `getAgent(db, name)` returns a row.
- `src/server/agent_routes.ts`.

## UI

- `web/src/tabs/AgentsTab.tsx` — card grid; admin-only create/edit.
- `web/src/components/AgentDialog.tsx` — form with prompt / tool picker / memory knobs / subagent flag.
- Project link/unlink checkboxes on the project dialog + on each agent card.

## Extension hooks

- **Translation:** no.
- **Trash:** no (hard delete removes DB row + directory contents).
- **Notifications:** no.
- **Scheduler:** no (agents can be *invoked by* scheduled tasks but aren't themselves schedulable).
- **Tools:** an agent's `tools = [...]` whitelist filters the registry. Empty list = full inheritance.

## Subagents

Enable `is_subagent = 1` on an agent. Add its name to another agent's `allowed_subagents`. The orchestrator receives a built-in `call_agent(name, prompt)` tool that spawns a nested `runAgent` with a silent renderer; the final answer surfaces as the tool result.

- Depth capped by `MAX_AGENT_CALL_DEPTH = 2`.
- SSE events (`content`, `reasoning`, `tool_call`, `tool_result`, `turn_end`) carry an optional `author` — `createSseRenderer(sink, { author })` tags every outgoing frame. The frontend `MessageBubble` renders `@name` in place of `assistant`.

## Context scope

- **`full`** (default) — recall sees every row in the session's project.
- **`own`** — recall filters to user turns + rows where `author = <this agent>`. Used for agents that should stay in their own lane and not contaminate context with peer agents' work.

`runAgent` passes `ownAuthor` to `getRecentTurns` + `hybridRecall` when the agent has `context_scope = 'own'`.

## Invocation paths

- **Chat mention** — `@name` in a prompt routes that turn to the agent.
- **Explicit `agent` field** — `POST /api/chat { agent, prompt }`.
- **Board card run** — `src/board/run_card.ts` sets `agent` from `card.assignee_agent`.
- **Web News topic** — each topic has its own `agent`; `runTopic` passes it through.
- **Subagent** — via `call_agent` tool.

## Key invariants

- **Agent replaces the default assistant for that turn.** No fallback, no double-answer.
- **`messages.author` is append-only.** Never drop the column.
- **Memory knob precedence: agent → project → global.**
- **A mention without a trailing prompt returns 400.** Don't silently run an empty turn.

## Gotchas

- `agents` directory is not a git-tracked location — it's per-installation. Seeding a new environment means re-creating agents through the UI or by copying the TOML files.
- `knows_other_agents = 1` injects a peer list into the system prompt — useful for orchestrators, noisy for specialists. Off by default.
- Agent renames are not supported (name is PK). To rename, delete + recreate, or add a new row and dual-publish.
- Deleting an agent that's currently linked to projects also removes the join rows; careful with shared agents.

## Default agent

A configurable default agent (`bunny`, override via `[agent] default_agent` or `BUNNY_DEFAULT_AGENT`) is seeded at boot by `src/memory/agents_seed.ts:ensureDefaultAgent` and **auto-linked to every project** (existing rows at boot, new rows via `POST /api/projects`). It guarantees `/api/chat` can always resolve a named agent when the caller omits `agent` and the prompt has no leading `@mention`. The seeded `config.toml` uses `append = true` + `prompt = "You are a helpful assistant"` so operator `systemprompt.toml` overrides still apply. See [ADR 0031](../../adr/0031-every-chat-is-agent-bound.md).

## Composer agent picker

A per-session agent binding stored client-side in `localStorage["bunny.activeAgent.<sessionId>"]` (see `web/src/lib/activeAgent.ts`). The Composer exposes it as a small pill next to Send; selecting an agent updates the binding and is forwarded as `agent` in every subsequent `POST /api/chat` body. Default is the configured default agent. A `@mention` in the prompt still overrides for that single turn. Switching project forces a new session which resets the binding.

## Sidebar "New chat with…"

Entry point (`Plus` icon next to the Chat nav item) that opens a modal picker (`web/src/components/NewChatWithAgentDialog.tsx`). On pick, the UI mints a new session, writes the agent into `bunny.activeAgent.<newSid>`, and navigates to Chat. No new backend route — the first `POST /api/chat` carries the binding.

## Label rendering

User bubbles show `displayName || username || "you"`; assistant bubbles show `@<author>` and fall back to `@<configured default>` for legacy NULL-author rows. Rendered via `resolveBubbleLabel` (`web/src/lib/messageLabel.ts`) with the default agent flowing through `DefaultAgentContext` seeded from `/api/auth/me`. Zero DB rewrites — substitution is UI-only.

## Related

- [ADR 0009 — Agents](../../adr/0009-agents.md)
- [ADR 0031 — Every chat turn is bound to a named agent](../../adr/0031-every-chat-is-agent-bound.md)
- [`../concepts/agent-loop.md`](../concepts/agent-loop.md)
- [`../concepts/memory-and-recall.md`](../concepts/memory-and-recall.md) — `context_scope = "own"`.
- [`./skills.md`](./skills.md) — progressive disclosure of instructions.
- [`../how-to/add-a-tool.md`](../how-to/add-a-tool.md).
