# Bunny

A Bun-native AI agent. Minimal architecture, queue-backed logging, hybrid memory (BM25 + vector) from day one.

## Status

Phase 1 (MVP) — in development. See [`docs/README.md`](./docs/README.md) for architecture and [`docs/adr/`](./docs/adr/) for design decisions.

## Quick start

```sh
bun install
cp .env.example .env     # fill LLM_API_KEY
bun run src/index.ts "list the files in src/"
```

State goes into `./.bunny/` (override with `BUNNY_HOME`). Database is SQLite, everything is portable.

### Projects

Every message belongs to a **project** — a logical workspace with its own system prompt (in `projects/<name>/systemprompt.toml`) and isolated recall. The default project is called `general`. Create a new project from the web UI ("Projects" tab → `+ New project`), or directly on the CLI:

```sh
bun run src/index.ts --project alpha "write an intro for this project"
```

The CLI auto-creates the DB row and directory if they don't exist yet. Switching projects starts a new session — one session belongs to exactly one project. See [ADR 0008](./docs/adr/0008-projects.md).

### Multi-language translation

A project can declare a list of **languages** plus a default. Every KB definition, document, contact `notes`, and board card is authored in one source language (picked from the project's list, defaulting to the user's preferred language when set) and automatically translated into the project's other languages by a scheduled task (every 5 minutes). Translations are read-only; only the source is editable. Editing a source field marks translations `stale`; edit-and-revert is a zero-cost no-op because we hash the source fields. Open any entity dialog to see the language tabstrip — the source tab is editable, the others show the translated content with a status pill and a "Translate now" button. Set your own `preferred_language` in Settings to control both which language new entities are authored in and which tab opens first when you view an existing one. See [ADR 0022](./docs/adr/0022-multi-language-translation.md).

### Agents

An **agent** is a named personality with its own system prompt and a restricted tool-set. Create one in the web UI ("Agents" tab → `+ New agent`), link it to a project, and invoke it in Chat by prefixing your message with `@name`:

```
@bob find out whether there are duplicate functions in src/tools
```

Agents can also talk to each other: enable `is_subagent` on an agent and add it to an orchestrator's `allowed_subagents`, then the orchestrator receives the `call_agent(name, prompt)` tool. The context scope (`full` or `own`) determines whether an agent can see the whole session or only its own previous answers — handy for one-shot specialists. See [ADR 0009](./docs/adr/0009-agents.md).

### Boards

Every project has its own **kanban board**. Open the **Board** tab in the web UI: by default you see the Todo / Doing / Done swimlanes, drag cards between them or rename/delete lanes as admin or project-owner. A card can be assigned to a **user** or an **agent** — not both at once.

Cards with an agent-assignee can be executed via the **Run** button in the card dialog: bunny sends `title + description` as the prompt to the agent, streams the output live into the card, and persists the final answer on the run row. "Open in Chat" deep-links to the matching session so you can review the full trace (including tool-calls and reasoning). Re-runs remain as history on the card. See [ADR 0010](./docs/adr/0010-project-boards.md).

## Web UI

Bunny also has a tab-based web UI: **Dashboard** (KPIs, charts, activity feed), **Chat** (live streaming), **Messages** (all previous sessions from SQLite, searchable via BM25), **Board** (kanban per project, with optional auto-run per swimlane and per card), **Whiteboard** (per-project Excalidraw with AI edit/question modes), **Documents** (rich-text WYSIWYG editor with AI edit/question modes), **Contacts** (per-project contacts with groups, search, and vCard import/export), **Knowledge Base** (per-project glossary of project-specific definitions with manual + LLM-generated descriptions and sources), **News** (per-project periodic news aggregator — pick an agent, give it topics + a cron, and it curates a deduplicated overview rendered via swappable templates), **Files** (per-project workspace files, upload/download/drag-and-drop), **Tasks** (system and user tasks with cron schedules), **Projects**, **Agents**, **Skills** (reusable instruction packages), **Logs** (admin-only audit trail), and **Settings**.

```sh
# terminal 1 — backend (Bun HTTP + SSE)
bun run serve                       # or: bun run src/index.ts serve

# terminal 2 — frontend (Vite dev server, proxies to :3000)
cd web && bun install && bun run dev
# open http://localhost:5173
```

For production: `bun run web:build` builds `web/dist/`, after which `bun run serve` serves both the API and the static bundle on a single port.

For a portable binary with **everything inside** (CLI + server + embedded web UI):

```sh
bun run build                        # builds web/dist and compiles for all platforms
# or a single platform:
bun run build:platform darwin-arm64
./dist/bunny-darwin-arm64 serve      # UI at http://localhost:3000
```

At `build` time the Vite bundle is embedded into the binary as `import … with { type: "file" }` entries via a generated manifest (`src/server/web_bundle.ts`); the stub is restored after the compile so git stays clean.

Pre-built binaries for darwin/linux/windows (x64 + arm64) are available on the [GitHub Releases](https://github.com/Gomez12/bunny/releases) page — built automatically by the `Release` workflow on every `v*` tag.

See [`docs/adr/0006-web-ui.md`](./docs/adr/0006-web-ui.md) for the architectural choices.

## Authentication

On the first `bunny serve` boot the server creates an admin based on your config (default: `admin` / `change-me`). You must pick a new password on the first login in the web UI.

Configure in `bunny.config.toml`:

```toml
[auth]
default_admin_username = "admin"
default_admin_password = "change-me"   # override via BUNNY_DEFAULT_ADMIN_PASSWORD
session_ttl_hours = 168                # 7 days
```

Manage users in the web UI under **Settings → Users** (admin-only). Regular users only see their own sessions; admins see everything.

## Agents

Every chat turn is bound to a named agent. A default agent called `bunny` is seeded at boot and auto-linked to every project, so fresh installs chat out of the box. You can rename it or point to a different seeded persona:

```toml
[agent]
default_project = "general"             # override via BUNNY_DEFAULT_PROJECT
default_agent   = "bunny"               # override via BUNNY_DEFAULT_AGENT
```

The Composer has a per-session agent picker (remembered in `localStorage["bunny.activeAgent.<sessionId>"]`) and the sidebar has a **New chat with…** entry that starts a fresh session pre-bound to a picked agent. Assistant bubbles render as `@<agent>`; user bubbles render as the user's display name.

See [`docs/adr/0031-every-chat-is-agent-bound.md`](./docs/adr/0031-every-chat-is-agent-bound.md) for the details.

### CLI with an API key

Any user can create a key with a name + optional expiry under **Settings → API keys**. The plaintext secret is shown once — save it right away.

```sh
BUNNY_API_KEY=bny_xxxx_yyyy bun run src/index.ts "hi"
# or
bun run src/index.ts --api-key bny_xxxx_yyyy "hi"
```

Without a key the CLI runs under the seeded `system` user (backward-compat).

See [`docs/adr/0007-auth-and-users.md`](./docs/adr/0007-auth-and-users.md) for the architectural choices.

## Development

```sh
bun test          # unit + integration
bun run typecheck
bun run docs      # generate TypeDoc → docs/api/
```
