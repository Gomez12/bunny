# Setup

## Prerequisites

- **Bun ≥ 1.3.0.** Node is not supported — the project uses `bun:sqlite`, `Bun.serve`, `Bun.TOML`, `bun:test`.
- **macOS or Linux.** Windows has not been validated; WSL works.
- **Rust toolchain** (optional — only for the Tauri desktop client).
- **LLM provider API key.** Any OpenAI-compatible endpoint (OpenAI, DeepSeek, OpenRouter, Ollama, Anthropic-compat). See `concepts/streaming-and-renderers.md`.

## Install

```sh
# Backend
bun install

# Frontend (separate package.json)
cd web && bun install
cd -

# Tauri desktop client (optional, requires Rust)
cd client && bun install && cd -
```

## Environment

Secrets live in `.env` — everything else goes in `bunny.config.toml` (see `reference/env-and-config.md`).

Minimum viable `.env`:

```sh
LLM_API_KEY=sk-…          # used for all LLM calls
EMBED_API_KEY=sk-…        # optional — without it, recall falls back to BM25-only
```

The project creates `./.bunny/` on first run (SQLite DB + project dirs + workspaces). Override location with `BUNNY_HOME=/some/other/path`. Everything is portable — no `$HOME/.config` lookups.

## Run

Three entry points. Pick whichever matches what you're building.

### CLI — single turn

```sh
bun run src/index.ts "what is my memory limit?"
bun run src/index.ts --project alpha "summarise today's work"
bun run src/index.ts --session <uuid> --hide-reasoning "follow-up"
```

`--project <name>` auto-creates the project (DB row + directory) when missing. See `entities/chat.md` for how sessions are keyed.

### Web UI — two processes

```sh
bun run serve                # Bun HTTP + SSE on :3000
cd web && bun run dev        # Vite dev server on :5173 (proxies /api → :3000)
```

Open http://localhost:5173. First login uses the seeded admin (`admin` / `BUNNY_DEFAULT_ADMIN_PASSWORD`, default `admin`). You'll be forced to change the password on first login — see `concepts/auth.md`.

### Tauri desktop client

```sh
bun run client:dev           # dev mode, opens a native window
bun run client:build         # platform-specific installer
```

The client does *not* embed the server — it wraps the web UI in a native window and connects to a running Bunny instance. On first launch it asks for the server URL. See [ADR 0017](../../adr/0017-tauri-client.md).

## Scripts cheat-sheet

```sh
bun test                              # full suite
bun test tests/agent/render.test.ts   # single file
bun test -t "closes reasoning block"  # single test by name
bun test --watch                       # watch mode

bun run typecheck                      # tsc --noEmit
bun run fmt                            # prettier
bun run check                          # typecheck + test
bun run docs                           # TypeDoc → docs/api/

bun run web:build                      # build web/dist/ (Bun serves it on :3000 in prod)
bun run build                          # compile standalone binary (all platforms + Tauri)
bun run build:platform darwin-arm64    # single-platform build
bun run build -- --no-web              # reuse existing web/dist/
bun run build -- --no-client           # skip Tauri
bun run build -- --list                # list build targets
```

## State layout

Everything under `./.bunny/` (or `$BUNNY_HOME`):

```
.bunny/
├── bunny.db                           # SQLite — the one source of truth
├── projects/
│   └── <project-name>/
│       ├── systemprompt.toml          # per-project prompt override
│       └── workspace/
│           ├── input/                 # protected root
│           └── output/                # protected root
├── agents/
│   └── <agent-name>/
│       └── config.toml
└── skills/
    └── <skill-name>/
        └── SKILL.md
```

## Next

→ [architecture-tour.md](./architecture-tour.md)
