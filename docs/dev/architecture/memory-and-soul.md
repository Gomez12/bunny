# Memory and soul (per-user / per-agent)

> Hybrid recall (BM25 + kNN) covers _episodic_ memory — "did we talk about
> X". This page covers _persistent_ memory — "what do we know about you".

## At a glance

Three persistent text bodies, each capped at 4 000 characters, auto-curated
hourly by the `memory.refresh` scheduled handler:

| Where | Scope | Purpose |
| --- | --- | --- |
| `user_project_memory.memory` | one row per (user, project) | Facts about the user in this project |
| `agent_project_memory.memory` | one row per (agent, project) | What the agent has accumulated for this project |
| `users.soul` | one row per user (global) | Personality + style + stable preferences |

All three are spliced into every system prompt by `buildSystemMessage`'s new
`## Persistent context` block.

See [ADR 0034](../../adr/0034-per-user-agent-memory.md) for the rationale.

## Where it lives

- `src/memory/schema.sql` — `user_project_memory`, `agent_project_memory`,
  + seven `soul_*` columns on `users`.
- `src/memory/user_project_memory.ts` — CRUD + claim/release + sweep.
- `src/memory/agent_project_memory.ts` — same shape for agents.
- `src/auth/users.ts:setUserSoulManual` / `setUserSoulAuto` — soul CRUD.
- `src/memory/messages.ts:getUserProjectMessagesAfter` /
  `getProjectAgentMessagesAfter` / `getUserMessagesAfter` — analyser inputs.
- `src/memory/refresh_handler.ts` — the hourly handler `memory.refresh`.
- `src/memory/refresh_helpers.ts:loadMemoryContext` — read-side, called by
  `runAgent` once per turn.
- `src/agent/prompt.ts:buildMemoryBlock` — system-prompt rendering.
- `src/server/memory_routes.ts` — HTTP `/api/projects/:project/memory/*`.
- `src/server/auth_routes.ts` — HTTP `/api/users/me/soul`.
- `web/src/tabs/MemoryPanel.tsx` — Workspace → Memory sub-tab.
- `web/src/pages/SettingsPage.tsx:SoulForm` — Settings → Profile → soul.
- `src/prompts/registry.ts` — `memory.user_project.refresh`,
  `memory.agent_project.refresh`, `memory.user_soul.refresh`.

## State machine

Each row is a small state machine:

```
idle ──claim──▶ refreshing ──setAuto──▶ idle
                     │
                     └─setError──▶ error ──claim──▶ refreshing
                     │
                     └─sweepStuck──▶ idle  (after 30 min in 'refreshing')
```

`claim*ForRefresh` is atomic — it only flips when `status != 'refreshing'`
and returns false otherwise, mirroring `setLlmGenerating` in
`kb_definitions.ts`. `releaseStuck*` reclaims rows whose `refreshing_at` is
older than `cfg.memory.refreshStuckThresholdMs` so a process death mid-LLM
doesn't wedge the row forever.

## Scheduled refresh

`memory.refresh` cron `0 * * * *`. Per tick:

1. **Sweep stuck rows.** Three calls to `releaseStuck*` flip stale
   `refreshing` rows back to `idle` so they re-enter the candidate set.
2. **User-project pass.** A single CTE returns `(user_id, project, max_id,
   watermark)` for pairs whose `MAX(messages.id) > watermark`, ordered by
   `(max_id - watermark) DESC`. For each pair: `claim` (atomic), fetch the
   slice of messages past the watermark, build the per-row prompt via
   `resolvePrompt("memory.user_project.refresh", { project }) +
   interpolate(...)`, run the LLM via `runAgent` with `silentRenderer` and a
   hidden `memory-user-…` session, store the merged body, advance the
   watermark. Errors call `setUserProjectMemoryError` so the row drops back
   to `idle` with the error visible to the UI.
3. **Agent-project pass.** Same shape. The CTE finds sessions where the
   agent authored at least one assistant turn and scopes the watermark to
   the messages in those sessions.
4. **Soul pass.** Same shape, scoped per user across all projects.

Per-tick budget = `cfg.memory.refreshBatchSize` (default 50) LLM calls,
combined across all three passes. Excess rows wait one hour for the next
tick.

## Read-side: prompt injection

`runAgent` calls `loadMemoryContext(db, { userId, project, agent })` once per
turn before building the system prompt. Best-effort: failures (missing rows,
FK gaps) collapse to empty strings — memory injection must never break a
chat. The three returned strings flow into `BuildSystemMessageOpts.userSoul`,
`userMemory`, `agentProjectMemory`, plus `userDisplay` and `project` for
section headers.

`buildSystemMessage` adds the block **after** the
agent/project-layered prompt and **before** any `recall` block:

```
## Persistent context
### About <userDisplay> (personality + style)
<soul>

### What you know about <userDisplay> in project '<project>'
<userMemory>

### Your accumulated notes for project '<project>'
<agentProjectMemory>
```

Subsections are suppressed individually when their body is empty; the entire
block is skipped when all three are empty.

**Override-safe.** `runAgent` never injects memory when the caller passes
`systemPromptOverride`. That keeps fixed-prompt code paths (KB generate,
doc/whiteboard/contact edit, code edit, the memory-refresh handler itself,
…) deterministic, and prevents the system user's soul from leaking into a
soul-curation LLM call.

## HTTP API

Soul (own only):

- `GET /api/users/me/soul` → `{ soul, status, error, refreshedAt, manualEditedAt, maxChars }`.
- `PUT /api/users/me/soul` body `{ soul }` — validates `≤ maxChars`, stamps `soul_manual_edited_at`.

Per-(user, project):

- `GET/PUT /api/projects/:project/memory/me` — own row, any project viewer.
- `GET    /api/projects/:project/memory/users/:userId` — admin only.

Per-(agent, project):

- `GET/PUT /api/projects/:project/memory/agents/:agent` — read = any project
  viewer; write = admin OR project creator.

Every mutation logs through the queue (`topic: 'memory'`).

## Tuning

`bunny.config.toml`:

```toml
[memory]
# Existing keys (recall + replay):
last_n = 10
recall_k = 8
# Refresh-loop tuning (defaults shown):
refresh_batch_size = 50
refresh_max_messages_per_row = 200
refresh_stuck_threshold_ms = 1800000     # 30 min
```

## Manual edits vs. auto-refresh

The auto-refresh prompt instructs the LLM to **keep every fact in the
current memory body that still applies**, then add new ones from the message
slice and dedupe. So manual edits are seeds, not locks: they survive each
auto-refresh unless a later message contradicts them. Users who want a tweak
to truly stick edit the row again on the next cycle.

When the merged body would exceed 4 000 chars, the same prompt instructs the
LLM to **rewrite** to the most important + most recent facts within budget.
The cap is also enforced server-side at write time (`clampMemory`), so a
non-conforming model never blows the schema invariant.

## Limitations

- **Memory is not translated** in v1. Sidecar translation tables exist for
  KB/documents/contacts/board cards but not for memory or soul. Adding it is
  a future ADR — for now the prompt registry guides the LLM to follow the
  user's `preferred_language` automatically.
- **No backfill from history** — watermarks start at 0 and the first ticks
  catch up at most `refresh_max_messages_per_row` rows at a time. Users
  with deep history fill in over a few hours.
- **Soul is global per user**, not per project. If you want project-specific
  personality (e.g. formal in work, casual in hobby), use the per-project
  user_memory body for that.
