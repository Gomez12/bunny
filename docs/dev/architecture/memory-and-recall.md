# Memory and recall

## At a glance

Bunny has two memory mechanisms that work together:

- **Short-term replay** — the last `memory.last_n` user/assistant `content` turns are replayed verbatim on every request. Fixes coherence inside a session.
- **Long-term hybrid recall** — BM25 (FTS5 trigram) + kNN (sqlite-vec) fused via Reciprocal Rank Fusion (k=60). Top-`recall_k` (default 8) messages are injected into the system prompt.

Both mechanisms exclude each other's IDs so nothing duplicates.

## Where it lives

- `src/memory/schema.sql` — `messages`, `messages_fts`, and the dynamically-created `embeddings` vec0 table.
- `src/memory/messages.ts:insertMessage` — writes a row. One per semantic unit.
- `src/memory/messages.ts:getRecentTurns` — replays user/assistant content rows (filters out tool rows).
- `src/memory/bm25.ts:searchBM25` — FTS5 search with project/author filters.
- `src/memory/vector.ts:searchVector` — kNN over `embeddings`.
- `src/memory/recall.ts:hybridRecall` — RRF fusion over both.
- `src/memory/embed.ts` — embedding client (OpenAI-compat).

## The `messages` row

One row per semantic unit. `channel` tells you which kind:

| `channel` | What's in `content` | Sent to LLM on next turn? |
| --- | --- | --- |
| `content` | User or assistant text | Yes (via replay or recall) |
| `reasoning` | Model's thinking | No (except Anthropic-compat roundtrip) |
| `tool_call` | Serialised tool invocation | Part of the assistant message that produced it |
| `tool_result` | Serialised tool output | Part of the same turn that produced it |

Other important columns:

- `session_id` — groups a conversation.
- `project` — scope key. `COALESCE(project, 'general')` reads back legacy NULL rows.
- `author` — responding agent name. `NULL` = default assistant.
- `user_id` — owning user. Powers non-admin session-scoping.
- `attachments` — JSON array of `{kind, mime, dataUrl}`.
- `edited_at` / `trimmed_at` / `regen_of_message_id` — chat affordances (edit, save+regenerate, regenerate-as-alt-version).
- `provider_sig` — Anthropic-compat thinking-block signature.

## FTS5 sync

`messages_fts` mirrors `content`-channel rows only. Triggers (defined in `schema.sql`) keep it in sync on INSERT / DELETE / UPDATE and drop the row when `trimmed_at` is set. Reasoning and tool rows are *not* indexed — they belong to completed inner loops, not to searchable conversation history.

## Embeddings

The `embeddings` vec0 table is created at DB open by `db.ts`, not in `schema.sql` — the dimension must be baked into the `CREATE VIRTUAL TABLE` statement and is config-driven (default 1536). Failure to embed is non-fatal: if `EMBED_API_KEY` is missing or the call errors, `hybridRecall` degrades to BM25-only.

## Hybrid recall

```
hybridRecall(prompt, { project, excludeIds, recallK })
  ├─► searchBM25(prompt, project, …) → top K ids + ranks
  ├─► searchVector(prompt, project, …) → top K ids + ranks (skipped if no embed key)
  └─► RRF fuse (k=60) → top `recallK` rows
```

- Reciprocal Rank Fusion: for each id, `score = Σ 1 / (60 + rank_in_source)`.
- `excludeIds` is the set of replayed IDs; recall never surfaces something already in the short-term window.
- Project filter is mandatory — projects never leak into each other.
- Author filter is applied when the calling agent has `context_scope = "own"`.

## Short-term replay

`getRecentTurns(sessionId, { last_n, excludeChannels })` reads the most recent `last_n` user/assistant `content` rows. Tool rows (call/result) and reasoning rows are skipped. Result is spliced between the system prompt and the new user message.

- `memory.last_n = 0` disables replay entirely (recall-only mode).
- `last_n` and `recall_k` are overridable per-project (`systemprompt.toml` → `ProjectAssets.memory`) and per-agent. Precedence: agent → project → global.

## Key invariants

- **One row per semantic unit.** Never merge content + reasoning + tool_call into a single row.
- **FTS5 tracks `channel = 'content'` only.** Do not change this trigger.
- **Recall is always project-scoped.** No cross-project leakage is allowed.
- **Embedding failure never kills the turn.** BM25 alone is good enough.

## Gotchas

- Changing the embedding dimension requires a schema reset — the vec0 table bakes the dimension in. There's no migration path.
- `messages.project` defaults NULL for legacy rows. Any query that compares project must use `COALESCE(project, 'general')`.
- Deep-linking to a specific message (notifications) uses `messageId` — but if the message is `trimmed_at` or its session is hidden, the link may 404. Handle gracefully in the UI.
- `recall_k = 0` disables recall injection. The loop still builds the prompt, just without recall block.

## Related

- [ADR 0003 — SQLite FTS5 + sqlite-vec hybrid memory](../../adr/0003-sqlite-fts5-vec-hybrid.md)
- [`agent-loop.md`](./agent-loop.md) — who calls recall.
- [`../entities/chat.md`](../entities/chat.md) — the user-visible side of sessions + messages.
- [`../reference/data-model.md`](../reference/data-model.md) — the `messages` table in context.
