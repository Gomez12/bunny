# `docs/dev/` — developer handbook

Bunny has three reference corpora. They all disagree with each other occasionally; this is how to navigate them.

- [**CLAUDE.md**](../../CLAUDE.md) — authoritative for the coding agent. Terse, exhaustive, no pedagogical order. Read it straight through if you want every rule in one file.
- [**docs/dev/decisions/**](./decisions/) — 28 decision records. Authoritative for *why* a subsystem exists. Chronological; not a tutorial.
- **docs/dev/** (you are here) — human-oriented counterpart. Orientation, per-entity walkthroughs, per-UI-surface reference, extension recipes.

When two of these disagree, trust the code; then fix whichever doc was wrong.

## Read this first

If you're brand new:

1. [`getting-started/setup.md`](./setup/setup.md) — run the CLI, the web server, the Tauri client.
2. [`getting-started/architecture-tour.md`](./setup/architecture-tour.md) — the three design principles, one-turn data flow, top-level code map.
3. [`getting-started/first-change.md`](./setup/first-change.md) — guided walkthrough: queue log → column → route → test.
4. [`getting-started/conventions.md`](./setup/conventions.md) — the non-negotiables (English-only, append-only schema, queue-log mandate, pre-commit checklist).

## Folder map

### [`getting-started/`](./setup/)
Onboarding journey. Read top-to-bottom on day one.

### [`concepts/`](./architecture/)
Backend / cross-cutting subsystems. One page per subsystem. Skim the READMEs; jump in when you touch something.

- [agent-loop](./architecture/agent-loop.md) · [streaming-and-renderers](./architecture/streaming-and-renderers.md) · [memory-and-recall](./architecture/memory-and-recall.md)
- [queue-and-logging](./architecture/queue-and-logging.md) · [auth](./architecture/auth.md) · [projects-as-scope](./architecture/projects-as-scope.md)
- [scheduler](./architecture/scheduler.md) · [translation-pipeline](./architecture/translation-pipeline.md) · [soft-delete-and-trash](./architecture/soft-delete-and-trash.md)
- [notifications-and-fanout](./architecture/notifications-and-fanout.md) · [telegram-integration](./architecture/telegram-integration.md)

### [`ui/`](./components/)
Everything frontend-specific. A peer of `concepts/` because the frontend codebase (`web/src/**`) is substantial enough to merit its own surface.

- [shell-and-navigation](./components/shell-and-navigation.md) · [design-system](./components/design-system.md) · [icons-and-rabbit](./components/icons-and-rabbit.md)
- [component-library](./components/component-library.md) · [patterns](./components/patterns.md) · [state-and-hooks](./components/state-and-hooks.md)
- [streaming-ui](./components/streaming-ui.md) · [tiptap-extensions](./components/tiptap-extensions.md)

### [`entities/`](./architecture/entities/)
User-facing things. One page per entity — data model, HTTP API, code paths, UI, extension hooks.

- [chat](./architecture/entities/chat.md) · [agents](./architecture/entities/agents.md) · [skills](./architecture/entities/skills.md) · [boards](./architecture/entities/boards.md) · [tasks](./architecture/entities/tasks.md)
- [documents](./architecture/entities/documents.md) · [whiteboards](./architecture/entities/whiteboards.md) · [files](./architecture/entities/files.md) · [contacts](./architecture/entities/contacts.md)
- [knowledge-base](./architecture/entities/knowledge-base.md) · [web-news](./architecture/entities/web-news.md) · [dashboard](./architecture/entities/dashboard.md) · [integrations](./architecture/entities/integrations.md)

### [`how-to/`](./agents/)
Recipes for common extension points.

- [add-a-tool](./agents/add-a-tool.md) · [add-a-scheduled-handler](./agents/add-a-scheduled-handler.md)
- [add-a-translatable-entity](./agents/add-a-translatable-entity.md) · [add-a-trashable-entity](./agents/add-a-trashable-entity.md)
- [add-an-http-route](./agents/add-an-http-route.md) · [add-a-nav-tab](./agents/add-a-nav-tab.md)
- [add-a-ui-component](./agents/add-a-ui-component.md) · [add-a-tiptap-node](./agents/add-a-tiptap-node.md)
- [add-a-provider](./agents/add-a-provider.md) · [write-a-test](./agents/write-a-test.md)

### [`reference/`](./architecture/reference/)
Flat look-ups. No narrative, just tables.

- [data-model](./architecture/reference/data-model.md) · [sse-events](./architecture/reference/sse-events.md) · [env-and-config](./architecture/reference/env-and-config.md)

## Conventions for this folder

- **English only.** Everything in the repo is English — see `CLAUDE.md` §Conventions.
- **Summarise + link.** Pages here are orientation. Canonical sources are `CLAUDE.md`, the ADRs, and the code. Do not duplicate rationale — link down.
- **Anchor claims.** Reference files by path + symbol name (`src/agent/loop.ts:runAgent`) rather than bare line numbers — line numbers rot fast.
- **Ship docs with code.** If a PR changes a subsystem, the matching `docs/dev/` page updates in the same PR. Stale dev docs are worse than no dev docs.
