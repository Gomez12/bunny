# Bunny — architecture

Bunny is a Bun-native AI agent. Three design principles:

1. **Minimal agent loop** — conversation history + tool registry + LLM + executor. Nothing more. (See Mihail Eric, _The Emperor Has No Clothes_.)
2. **Queue is the spine** — every LLM call, tool call and memory write is a job on [bunqueue](https://github.com/egeominotti/bunqueue). Middleware logs input/output/duration to SQLite. Nothing disappears unseen.
3. **Portable state** — everything relative to cwd under `./.bunny/` (override via `$BUNNY_HOME`). No `$HOME/.config`. A project directory is a complete, relocatable agent.

## Data-flow (one turn)

```
CLI ──► runAgent(prompt)
          │
          ▼
     queue.llm ──► adapter SSE stream
          │              │
          │              ├──► delta: content    ─► render (plain)
          │              ├──► delta: reasoning  ─► render (dim italic)
          │              └──► delta: tool_call  ─► render (cyan)
          │
          ▼
       accumulated message ──► events + messages (+ FTS5 + vector embedding)
          │
          ▼
       tool_calls? ──► queue.tool ──► fs_read / fs_list / fs_edit
          │                              │
          └──────────────────────────────┘  (loop until assistant answers without tool_calls)
```

The next turn reads `recall.hybrid(prompt, k=8)` from memory — top-k messages via Reciprocal Rank Fusion over BM25 (SQLite FTS5) and kNN (sqlite-vec).

## Provider profiles (streaming + reasoning)

| Profile            | content                           | reasoning                             |
| ------------------ | --------------------------------- | ------------------------------------- |
| `openai`           | `choices[].delta.content`         | `choices[].delta.reasoning_content`\* |
| `deepseek`         | `choices[].delta.content`         | `choices[].delta.reasoning_content`   |
| `openrouter`       | pass-through (per model)          | pass-through                          |
| `ollama`           | `choices[].delta.content`         | — (usually absent)                    |
| `anthropic-compat` | content-block                     | `thinking` block + signature          |

\* Only o1/o3 and specific variants; other OpenAI models carry no reasoning.

Reasoning is stored on `messages.channel='reasoning'` (visible in UI, not used in recall unless `[memory].index_reasoning = true`), and **not** sent back to the LLM on follow-up turns — except for providers that require it (Anthropic thinking-blocks with signature roundtrip).

## Web UI

Next to the CLI, Bunny runs a web UI (`bunny serve`) with thirteen tabs (in order): **Dashboard** (KPIs, time-series charts, activity feed — see [ADR 0014](./adr/0014-dashboard.md)), **Chat** (live streaming, scoped to the active project; agents callable via `@name`), **Messages** (all sessions for the active project, BM25-searchable), **Board** (Trello-style kanban per project — drag-and-drop, assign cards to a user or agent, and the **Run** button lets the agent execute the card with live SSE streaming), **Whiteboard** (per-project Excalidraw whiteboards with AI-powered edit and question modes — see [ADR 0015](./adr/0015-whiteboards.md)), **Documents** (per-project rich-text WYSIWYG documents backed by Tiptap, stored as markdown, with Word ribbon toolbar, code-mode toggle, and AI edit/question modes — see [ADR 0016](./adr/0016-documents.md)), **Files** (per-project workspace file browser — see [ADR 0012](./adr/0012-project-workspaces.md)), **Tasks** (system and user scheduled tasks with cron — see [ADR 0011](./adr/0011-scheduled-tasks.md)), **Projects** (card grid + create/edit dialog), **Agents** (personalities with their own prompt/tools, per-project opt-in, subagent orchestration via `call_agent`), **Skills** (reusable instruction packages, install from GitHub/skills.sh — see [ADR 0013](./adr/0013-agent-skills.md)), **Logs** (admin-only audit trail of queue events), and **Settings** (own profile, API keys, and user management for admins). See [ADR 0006](./adr/0006-web-ui.md) for the UI layout, [ADR 0007](./adr/0007-auth-and-users.md) for the auth layer, [ADR 0008](./adr/0008-projects.md) for the projects concept, [ADR 0009](./adr/0009-agents.md) for agents and [ADR 0010](./adr/0010-project-boards.md) for the board. The agent loop is unchanged — the webserver plugs into the same `Renderer` interface as the CLI (via `createSseRenderer`) and passes the authenticated `userId` + optional `agent` to `runAgent`.

## Desktop Client

A Tauri v2 desktop app (`client/`) wraps the web UI in a native window. It connects to a running Bunny server — no embedded server logic. On first launch a setup page asks for the server URL; after saving, subsequent launches navigate directly. Build with `bun run client:build` (requires Rust toolchain). See [ADR 0017](./adr/0017-tauri-client.md).

## See also

- [ADR 0001 — Bun as runtime](./adr/0001-bun-runtime.md)
- [ADR 0002 — OpenAI-compat adapter](./adr/0002-openai-compat-adapter.md)
- [ADR 0003 — SQLite FTS5 + sqlite-vec hybrid memory](./adr/0003-sqlite-fts5-vec-hybrid.md)
- [ADR 0004 — Bunqueue as spine](./adr/0004-bunqueue-as-spine.md)
- [ADR 0005 — Streaming and reasoning normalisation](./adr/0005-streaming-reasoning.md)
- [ADR 0006 — Web UI (Chat + Messages)](./adr/0006-web-ui.md)
- [ADR 0007 — Authentication, users, roles and API keys](./adr/0007-auth-and-users.md)
- [ADR 0008 — Projects](./adr/0008-projects.md)
- [ADR 0009 — Agents](./adr/0009-agents.md)
- [ADR 0010 — Project boards](./adr/0010-project-boards.md)
- [ADR 0011 — Scheduled tasks](./adr/0011-scheduled-tasks.md)
- [ADR 0012 — Project workspaces](./adr/0012-project-workspaces.md)
- [ADR 0013 — Agent skills](./adr/0013-agent-skills.md)
- [ADR 0014 — Dashboard](./adr/0014-dashboard.md)
- [ADR 0015 — Whiteboards](./adr/0015-whiteboards.md)
- [ADR 0016 — Documents](./adr/0016-documents.md)
- [ADR 0017 — Tauri desktop client](./adr/0017-tauri-client.md)
- [ADR 0018 — Web tools](./adr/0018-web-tools.md)
