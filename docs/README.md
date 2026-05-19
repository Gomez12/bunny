# Bunny — architecture

Bunny is a Bun-native AI agent. Three design principles:

1. **Minimal agent loop** — conversation history + tool registry + LLM + executor. Nothing more. (See Mihail Eric, _The Emperor Has No Clothes_.)
2. **Queue is the spine** — every LLM call, tool call and memory write is a job on [bunqueue](https://github.com/egeominotti/bunqueue). Middleware logs input/output/duration to SQLite. Nothing disappears unseen.
3. **Portable state** — everything relative to cwd under `./.bunny/` (override via `$BUNNY_HOME`). No `$HOME/.config`. A project directory is a complete, relocatable agent.

> **Working on Bunny?** Start with the developer handbook: [**docs/dev/**](./dev/). Onboarding walkthrough, per-entity reference, UI surface, extension recipes — the human-oriented counterpart to the ADR corpus.

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

Next to the CLI, Bunny runs a web UI (`bunny serve`) with a left sidebar grouped into four sections:

- **Work** — **Chat** (live streaming, scoped to the active project; agents callable via `@name`; session list built into the sidebar), **Board** (Trello-style kanban per project — drag-and-drop, assign cards to a user or agent, and the **Run** button lets the agent execute the card with live SSE streaming), **Tasks** (system and user scheduled tasks with cron — see [ADR 0011](./dev/decisions/0011-scheduled-tasks.md)).
- **Content** — **Documents** (per-project rich-text WYSIWYG documents backed by Tiptap — see [ADR 0016](./dev/decisions/0016-documents.md)), **Whiteboard** (per-project Excalidraw whiteboards with AI-powered edit and question modes — see [ADR 0015](./dev/decisions/0015-whiteboards.md)), **Files** (per-project workspace file browser — see [ADR 0012](./dev/decisions/0012-project-workspaces.md)), **Contacts** (per-project contact cards with groups, search, and vCard import/export — see [ADR 0019](./dev/decisions/0019-contacts.md)), **Knowledge Base** (per-project dictionary of project-specific terms with manual + LLM-generated descriptions and sources — see [ADR 0021](./dev/decisions/0021-knowledge-base-definitions.md)), **News** (per-project periodic news aggregator — agents scour the web on a cron and roll items up into a template-rendered overview — see [ADR 0024](./dev/decisions/0024-web-news.md)).
- **Configure** — **Workspace** (Projects / Agents / Skills as inner sub-tabs — see [ADRs 0008](./dev/decisions/0008-projects.md), [0009](./dev/decisions/0009-agents.md), [0013](./dev/decisions/0013-agent-skills.md)).
- **System** — **Dashboard** (KPIs, time-series charts, activity feed — see [ADR 0014](./dev/decisions/0014-dashboard.md)), **Settings** (own profile, API keys, user management for admins, and admin-only Logs sub-tab with the audit trail of queue events).

See [ADR 0006](./dev/decisions/0006-web-ui.md) for the UI layout, [ADR 0020](./dev/decisions/0020-ui-redesign-and-styleguide.md) for the sidebar redesign, [ADR 0007](./dev/decisions/0007-auth-and-users.md) for the auth layer and [ADR 0010](./dev/decisions/0010-project-boards.md) for the board. The agent loop is unchanged — the webserver plugs into the same `Renderer` interface as the CLI (via `createSseRenderer`) and passes the authenticated `userId` + optional `agent` to `runAgent`.

The visual language (tokens, components, icon system, rabbit mascot) is documented in the **[styleguide](./dev/styleguide/README.md)** — consult it before adding UI.

## Desktop Client

A Tauri v2 desktop app (`client/`) wraps the web UI in a native window. It connects to a running Bunny server — no embedded server logic. On first launch a setup page asks for the server URL; after saving, subsequent launches navigate directly. Build with `bun run client:build` (requires Rust toolchain). See [ADR 0017](./dev/decisions/0017-tauri-client.md).

## See also

- [ADR 0001 — Bun as runtime](./dev/decisions/0001-bun-runtime.md)
- [ADR 0002 — OpenAI-compat adapter](./dev/decisions/0002-openai-compat-adapter.md)
- [ADR 0003 — SQLite FTS5 + sqlite-vec hybrid memory](./dev/decisions/0003-sqlite-fts5-vec-hybrid.md)
- [ADR 0004 — Bunqueue as spine](./dev/decisions/0004-bunqueue-as-spine.md)
- [ADR 0005 — Streaming and reasoning normalisation](./dev/decisions/0005-streaming-reasoning.md)
- [ADR 0006 — Web UI (Chat + Messages)](./dev/decisions/0006-web-ui.md)
- [ADR 0007 — Authentication, users, roles and API keys](./dev/decisions/0007-auth-and-users.md)
- [ADR 0008 — Projects](./dev/decisions/0008-projects.md)
- [ADR 0009 — Agents](./dev/decisions/0009-agents.md)
- [ADR 0010 — Project boards](./dev/decisions/0010-project-boards.md)
- [ADR 0011 — Scheduled tasks](./dev/decisions/0011-scheduled-tasks.md)
- [ADR 0012 — Project workspaces](./dev/decisions/0012-project-workspaces.md)
- [ADR 0013 — Agent skills](./dev/decisions/0013-agent-skills.md)
- [ADR 0014 — Dashboard](./dev/decisions/0014-dashboard.md)
- [ADR 0015 — Whiteboards](./dev/decisions/0015-whiteboards.md)
- [ADR 0016 — Documents](./dev/decisions/0016-documents.md)
- [ADR 0017 — Tauri desktop client](./dev/decisions/0017-tauri-client.md)
- [ADR 0018 — Web tools](./dev/decisions/0018-web-tools.md)
- [ADR 0019 — Contacts](./dev/decisions/0019-contacts.md)
- [ADR 0020 — UI redesign & styleguide](./dev/decisions/0020-ui-redesign-and-styleguide.md)
- [ADR 0021 — Knowledge Base: definitions](./dev/decisions/0021-knowledge-base-definitions.md)
- [ADR 0022 — Multi-language translation](./dev/decisions/0022-multi-language-translation.md)
- [ADR 0023 — Chat refinements: Quick Chats, Fork, Edit & Regenerate](./dev/decisions/0023-chat-quick-chats-fork-edit-regen.md)
- [ADR 0024 — Web News](./dev/decisions/0024-web-news.md)
- [ADR 0025 — Soft-delete and trash bin](./dev/decisions/0025-soft-delete-and-trash.md)
- [ADR 0026 — Interactive user questions (`ask_user` tool)](./dev/decisions/0026-ask-user-question-tool.md)
- [ADR 0027 — User notifications](./dev/decisions/0027-user-notifications.md)
- [ADR 0028 — Per-project Telegram integration](./dev/decisions/0028-telegram-integration.md)
- [ADR 0029 — Prompt registry with two-tier overrides](./dev/decisions/0029-prompt-registry-and-two-tier-overrides.md)
- [ADR 0030 — Code sub-application](./dev/decisions/0030-code-sub-application.md)
- [ADR 0031 — Every chat is agent-bound](./dev/decisions/0031-every-chat-is-agent-bound.md)
- [ADR 0032 — Workflows subsystem](./dev/decisions/0032-workflows-subsystem.md)
- [ADR 0033 — Bun-native code knowledge graph](./dev/decisions/0033-bun-native-code-graph.md)
- [ADR 0034 — Per-user / per-agent memory + per-user soul](./dev/decisions/0034-per-user-agent-memory.md)
- [ADR 0035 — LLM concurrency gate](./dev/decisions/0035-llm-concurrency-gate.md)
- [ADR 0036 — Social handles + businesses](./dev/decisions/0036-social-handles-and-businesses.md)
- [ADR 0037 — Scripts subsystem](./dev/decisions/0037-scripts-subsystem.md)
- [ADR 0038 — News feeds and site monitor](./dev/decisions/0038-news-feeds-and-site-monitor.md)
- [ADR 0039 — Code-project secrets](./dev/decisions/0039-code-project-secrets.md)
- [ADR 0040 — Diagrams subsystem](./dev/decisions/0040-diagrams-subsystem.md)
- [ADR 0041 — Diary subsystem](./dev/decisions/0041-diary-subsystem.md)
- [ADR 0042 — Electron client](./dev/decisions/0042-electron-client.md)
- [ADR 0043 — Planning subsystem](./dev/decisions/0043-planning-subsystem.md)
- [Agent tools reference](./dev/api/tools.md)
- [HTTP API reference](./dev/api/http-api.md)
- [Styleguide](./dev/styleguide/README.md)
