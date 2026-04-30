# ADR 0034 — Per-user / per-agent memory + per-user soul

Status: Accepted — 2026-04-30

## Context

Recall (ADR 0003 — FTS5 + sqlite-vec) gives the agent fragments of past
turns ranked by relevance to the current prompt. It is excellent at "did we
already discuss X" but bad at "what does this user habitually prefer", which
needs an aggregated, compact record that doesn't depend on the current query.

Users asked for two things:

1. A short, hand-editable text field per (user, project) and per (agent,
   project) capturing **facts** the system has learned in that scope.
2. A short, hand-editable text field per user capturing **personality + style
   + stable preferences** (the "soul"), independent of project.

Both fields must be spliced into every system prompt so chats inherit them
automatically, and both must improve over time without manual curation.

## Decision

Three new persistent text bodies, each capped at 4 000 characters:

- `user_project_memory(user_id, project)` — facts about a user inside a project.
- `agent_project_memory(agent, project)` — facts an agent has accumulated
  about its project (recurring users, conventions, decisions).
- `users.soul` — global personality + style profile per user.

A new scheduled handler `memory.refresh` (cron `0 * * * *`) walks every active
row, fetches new content messages past the row's `watermark_message_id`, and
asks an LLM to merge the deltas into the existing body. If the merged body
would exceed the 4 k cap, the same prompt instructs the LLM to **rewrite the
entire body keeping only the most important and most recent facts**. So the
hard cap is enforced at write time (truncation) and at compaction time (the
LLM compresses).

### Schema

Two append-only tables, plus seven `users` columns. Schema is append-only by
convention (see ADR 0003) — never altered, never dropped.

```sql
CREATE TABLE user_project_memory (
  user_id              TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project              TEXT    NOT NULL REFERENCES projects(name) ON DELETE CASCADE,
  memory               TEXT    NOT NULL DEFAULT '',
  status               TEXT    NOT NULL DEFAULT 'idle',
  error                TEXT,
  watermark_message_id INTEGER NOT NULL DEFAULT 0,
  manual_edited_at     INTEGER,
  refreshed_at         INTEGER,
  refreshing_at        INTEGER,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  PRIMARY KEY (user_id, project)
);
-- agent_project_memory has the same shape, keyed (agent, project).
-- users gets: soul + soul_status + soul_error + soul_watermark_message_id +
-- soul_refreshed_at + soul_refreshing_at + soul_manual_edited_at.
```

`status` is a tiny state machine: `idle → refreshing → (idle | error)`. The
auto-cycle locks via `status='refreshing'` + `refreshing_at`. Stuck rows
(process death mid-call) are reclaimed at the start of every tick by
comparing `refreshing_at` to `cfg.memory.refreshStuckThresholdMs` (default
30 minutes), mirroring `kb.sweep_stuck`.

### Watermark, not "last 24 h"

Every row carries `watermark_message_id = MAX(message.id) at last successful
refresh`. The handler's analyser fetches messages with `id > watermark`
(LIMIT `cfg.memory.refreshMaxMessagesPerRow`, default 200). When there is
nothing new, the row is left untouched; we don't burn an LLM call to confirm
"still nothing". Idempotent under retries: even after a crash, the next tick
sees the same `id > watermark` slice.

### Per-(user, project) and per-(agent, project), not global

We considered keeping memory global per user / per agent, with all projects
fused. That makes manual editing simpler but loses signal — a user who is
formal in their work project and casual in a hobby project would have those
collapse into one bland average. Project-scoped rows preserve that contrast.
Soul stays global because personality is intrinsic.

### Source for agent memory: both halves of the conversation

The agent learns from sessions where it itself authored at least one
assistant turn. Inside those sessions we feed the analyser **all** content
messages — both user prompts addressed to it and its own replies. The
alternative ("only user prompts" or "only assistant replies") starves the
analyser of the response side and produces shallow memories.

### Manual edits: merge, not lock

Manual edits flow through the same row. The next auto-cycle treats the
existing body as the trusted seed and merges new facts in. No lock-flag
ceremony — the prompt explicitly tells the LLM to keep the seed unless a fact
has been falsified. If a user wants their tweak to stick, it sticks until a
later message contradicts it. Simple.

### Prompt injection

`buildSystemMessage` grew three optional inputs: `userSoul`, `userMemory`,
`agentProjectMemory`. When any are non-empty, the system prompt now contains
a `## Persistent context` block with up to three subsections. `runAgent` calls
`loadMemoryContext(db, …)` once per turn, so every code path that goes
through the agent loop (chat, regenerate, board card runs, web news, code
chat, KB definition generate, telegram, …) inherits memory automatically —
**except** code paths that pass `systemPromptOverride` (KB generate, doc
edit, the memory.refresh handler itself), which bypass injection so their
fixed system prompts stay deterministic and the soul-of-the-system-user
doesn't leak into a memory-curation run.

### Budget and rotation

The handler iterates from a single `WITH active AS (…)` CTE per category
that returns `(scope, project, max_id, watermark)` only for rows with new
content past the watermark, ordered by `(max_id - watermark)` descending —
the busiest rows go first. The cron runs hourly; the per-tick cap is
`cfg.memory.refreshBatchSize` (default 50) LLM calls combined across user
memory + agent memory + soul. Excess rows wait one hour for the next tick.

## Consequences

- **Schema:** two new tables, seven new `users` columns. Append-only.
- **Cost:** up to 50 LLM calls per hour by default. Tunable via
  `[memory] refresh_batch_size` in `bunny.config.toml`. With no traffic the
  scan terminates immediately — the candidate query returns zero rows.
- **Privacy:** memory content is admin-readable via
  `GET /api/projects/:project/memory/users/:userId`. Owner-edit only on the
  user's own row; agent memory edit needs admin or project creator.
- **Translation:** memory is **not** translated in v1. Markdown rendering
  works in any language; the prompt registry guides the LLM to follow the
  user's language. Adding sidecar translation is left for a future ADR.
- **No backfill:** we don't pre-fill memory from historical messages; the
  watermark starts at 0 and the first hourly tick catches up at most
  `refreshMaxMessagesPerRow` per row. Users with deep history will see their
  memory grow over a few cycles.

## Out of scope

- Per-skill / per-card memory (only user + agent + soul in v1).
- Sidecar translation of memory bodies.
- Manual lock flag for "do not auto-update" (merge strategy is enough; users
  who want a frozen body can edit on every cycle).
- Embedding the memory body for hybrid recall (FTS5 over the normal
  `messages` table is enough; memory itself is small).

## References

- `src/memory/schema.sql` — table definitions
- `src/memory/user_project_memory.ts` / `src/memory/agent_project_memory.ts`
- `src/memory/refresh_handler.ts` — the hourly handler
- `src/memory/refresh_helpers.ts:loadMemoryContext` — runtime injection
- `src/agent/prompt.ts:buildMemoryBlock` — system-prompt rendering
- `src/server/memory_routes.ts` + `src/server/auth_routes.ts` (soul) — HTTP
- `web/src/tabs/MemoryPanel.tsx` + `web/src/pages/SettingsPage.tsx` — UI
- ADR 0029 — prompt registry (entries `memory.user_project.refresh`,
  `memory.agent_project.refresh`, `memory.user_soul.refresh`)
