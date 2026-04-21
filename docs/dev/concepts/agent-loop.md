# Agent loop

## At a glance

`src/agent/loop.ts:runAgent` is the *only* orchestrator in the system. There is no parallel loop, no alternative scheduler, no "advanced" version. Everything else — CLI, HTTP chat, board card runs, document edit mode, scheduled tasks, Telegram inbound, Web News fetches, translation, KB generation — eventually calls this one function with different options.

The loop has a hard cap of `MAX_TOOL_ITERATIONS = 20` inner iterations per turn; after that the agent must answer without tools.

## Where it lives

- `src/agent/loop.ts:runAgent` — the loop.
- `src/agent/prompt.ts:buildSystemMessage` — composes the system prompt (base + agent + project + hybrid recall).
- `src/agent/render.ts` — the transport-agnostic `Renderer` interface.
- `src/agent/render_sse.ts:createSseRenderer` — SSE implementation for the web.
- `src/agent/tool_registry.ts` — `ToolRegistry`, `subset`, closure-bound dynamic tools.
- `src/agent/mention.ts:parseMention` — strips leading `@agent` off a prompt.
- `src/agent/ask_user_registry.ts` — blocking-question primitive, keyed by `sessionId::questionId`.

## The shape

```
┌───────────────────────────────────────────────────────────────┐
│ runAgent({ prompt, sessionId, project?, agent?, …options })   │
│                                                               │
│  1. Resolve agent assets (prompt + tool whitelist + memory    │
│     knobs). Agent → project → global precedence.              │
│                                                               │
│  2. buildSystemMessage(base, agentPrompt, projectPrompt,      │
│     hybridRecall, skillsCatalog).                             │
│                                                               │
│  3. Splice getRecentTurns(last_n) between system and user.    │
│                                                               │
│  4. Build the per-run tool registry:                          │
│       base registry .subset(filter)                           │
│       + closure-bound dynamic tools (ask_user, call_agent,    │
│         activate_skill, board tools, workspace tools,         │
│         web tools).                                           │
│                                                               │
│  5. Stream LLM → renderer (content / reasoning / tool_call).  │
│                                                               │
│  6. If tool_calls present → execute in parallel → insert      │
│     tool_result rows → goto 5.                                │
│                                                               │
│  7. If no tool_calls → insert assistant content row → done.   │
└───────────────────────────────────────────────────────────────┘
```

## Key options (`RunAgentOptions`)

| Option | Effect |
| --- | --- |
| `agent?: string` | Use this named agent instead of the default assistant. Inherits prompt, tools, memory knobs. |
| `project?: string` | Scope for messages, recall, tools. Session is locked to one project — mismatch throws. |
| `askUserEnabled` | Splice in `ask_user` tool. Only `POST /api/chat` and regenerate flip this on — the tool blocks and needs a UI to surface. |
| `mentionsEnabled` | Run the `@username` scanner on the prompt to fire notifications. Only `POST /api/chat` sets this. |
| `telegramCfg` | When set, mirror mentions to Telegram DMs. Only `POST /api/chat` passes this. |
| `webCfg` | Splice in `web_fetch` / `web_search` / `web_download`. KB, Web News, and any agent that wants them must pass this. |
| `systemPromptOverride` | Replaces the composed system prompt entirely. Used by edit-mode handlers (documents, whiteboards, KB, contacts). |
| `ownAuthor` | When agent has `context_scope = "own"`, restrict recall to user turns + rows authored by this agent. |
| `callDepth` | Subagent recursion counter. Capped by `MAX_AGENT_CALL_DEPTH = 2`. |
| `renderer` | The sink for streamed output. Swap implementations for different transports. |
| `userId` | Stamped on every `insertMessage` and `queue.log` call for attribution. |

## Key invariants

- **Only one orchestrator.** New features hook into `runAgent` via options. Do not copy-paste the loop.
- **Reasoning is stored but not replayed.** `messages.channel = 'reasoning'` rows are visible in the UI but not sent back to the LLM — except for Anthropic-compat providers that require the thinking-block signature roundtrip (`provider_sig` column).
- **Tools are closure-bound per run.** Dynamic tools (`ask_user`, `call_agent`, `activate_skill`, `board_*`, `workspace_*`, `web_*`) are built for this specific run with `project` / `db` / `userId` baked in, then spliced into the registry. A tool cannot leak across projects.
- **Message rows are atomic semantic units.** One row per `content` / `reasoning` / `tool_call` / `tool_result`. Never merge channels.

## Gotchas

- `context_scope = "own"` filters *recall* but not *replay*. `getRecentTurns` still replays the last-N rows verbatim; filtering only kicks in for hybridRecall. See `concepts/memory-and-recall.md`.
- Adding a new built-in dynamic tool means adding its name to `DYNAMIC_TOOL_NAMES` in `loop.ts` so `/api/tools` surfaces it and the agent picker can offer it.
- The loop catches errors from tools and turns them into `tool_result` rows with `ok = 0`. A tool that throws does not kill the turn — the LLM gets the error string and can recover.
- There is no retry. A 429 from the LLM bubbles up as an error; the client (CLI / UI) decides what to do.

## Related

- [ADR 0001 — Bun runtime](../../adr/0001-bun-runtime.md)
- [`streaming-and-renderers.md`](./streaming-and-renderers.md) — the adapter / renderer layer underneath.
- [`memory-and-recall.md`](./memory-and-recall.md) — what goes into the system prompt.
- [`queue-and-logging.md`](./queue-and-logging.md) — how the loop's work becomes the audit trail.
- [`../entities/chat.md`](../entities/chat.md) — the primary user-facing entry point.
- [`../how-to/add-a-tool.md`](../how-to/add-a-tool.md) — static vs dynamic/closure-bound tools.
