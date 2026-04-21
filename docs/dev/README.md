# `docs/dev/` — developer handbook

Bunny has three reference corpora. They all disagree with each other occasionally; this is how to navigate them.

- [**CLAUDE.md**](../../CLAUDE.md) — authoritative for the coding agent. Terse, exhaustive, no pedagogical order. Read it straight through if you want every rule in one file.
- [**docs/adr/**](../adr/) — 28 decision records. Authoritative for *why* a subsystem exists. Chronological; not a tutorial.
- **docs/dev/** (you are here) — human-oriented counterpart. Orientation, per-entity walkthroughs, per-UI-surface reference, extension recipes.

When two of these disagree, trust the code; then fix whichever doc was wrong.

## Read this first

If you're brand new:

1. [`getting-started/setup.md`](./getting-started/setup.md) — run the CLI, the web server, the Tauri client.
2. [`getting-started/architecture-tour.md`](./getting-started/architecture-tour.md) — the three design principles, one-turn data flow, top-level code map.
3. [`getting-started/first-change.md`](./getting-started/first-change.md) — guided walkthrough: queue log → column → route → test.
4. [`getting-started/conventions.md`](./getting-started/conventions.md) — the non-negotiables (English-only, append-only schema, queue-log mandate, pre-commit checklist).

## Folder map

### [`getting-started/`](./getting-started/)
Onboarding journey. Read top-to-bottom on day one.

### [`concepts/`](./concepts/)
Backend / cross-cutting subsystems. One page per subsystem. Skim the READMEs; jump in when you touch something.

- [agent-loop](./concepts/agent-loop.md) · [streaming-and-renderers](./concepts/streaming-and-renderers.md) · [memory-and-recall](./concepts/memory-and-recall.md)
- [queue-and-logging](./concepts/queue-and-logging.md) · [auth](./concepts/auth.md) · [projects-as-scope](./concepts/projects-as-scope.md)
- [scheduler](./concepts/scheduler.md) · [translation-pipeline](./concepts/translation-pipeline.md) · [soft-delete-and-trash](./concepts/soft-delete-and-trash.md)
- [notifications-and-fanout](./concepts/notifications-and-fanout.md) · [telegram-integration](./concepts/telegram-integration.md)

### [`ui/`](./ui/)
Everything frontend-specific. A peer of `concepts/` because the frontend codebase (`web/src/**`) is substantial enough to merit its own surface.

- [shell-and-navigation](./ui/shell-and-navigation.md) · [design-system](./ui/design-system.md) · [icons-and-rabbit](./ui/icons-and-rabbit.md)
- [component-library](./ui/component-library.md) · [patterns](./ui/patterns.md) · [state-and-hooks](./ui/state-and-hooks.md)
- [streaming-ui](./ui/streaming-ui.md) · [tiptap-extensions](./ui/tiptap-extensions.md)

### [`entities/`](./entities/)
User-facing things. One page per entity — data model, HTTP API, code paths, UI, extension hooks.

- [chat](./entities/chat.md) · [agents](./entities/agents.md) · [skills](./entities/skills.md) · [boards](./entities/boards.md) · [tasks](./entities/tasks.md)
- [documents](./entities/documents.md) · [whiteboards](./entities/whiteboards.md) · [files](./entities/files.md) · [contacts](./entities/contacts.md)
- [knowledge-base](./entities/knowledge-base.md) · [web-news](./entities/web-news.md) · [dashboard](./entities/dashboard.md) · [integrations](./entities/integrations.md)

### [`how-to/`](./how-to/)
Recipes for common extension points.

- [add-a-tool](./how-to/add-a-tool.md) · [add-a-scheduled-handler](./how-to/add-a-scheduled-handler.md)
- [add-a-translatable-entity](./how-to/add-a-translatable-entity.md) · [add-a-trashable-entity](./how-to/add-a-trashable-entity.md)
- [add-an-http-route](./how-to/add-an-http-route.md) · [add-a-nav-tab](./how-to/add-a-nav-tab.md)
- [add-a-ui-component](./how-to/add-a-ui-component.md) · [add-a-tiptap-node](./how-to/add-a-tiptap-node.md)
- [add-a-provider](./how-to/add-a-provider.md) · [write-a-test](./how-to/write-a-test.md)

### [`reference/`](./reference/)
Flat look-ups. No narrative, just tables.

- [data-model](./reference/data-model.md) · [sse-events](./reference/sse-events.md) · [env-and-config](./reference/env-and-config.md)

## Conventions for this folder

- **English only.** Everything in the repo is English — see `CLAUDE.md` §Conventions.
- **Summarise + link.** Pages here are orientation. Canonical sources are `CLAUDE.md`, the ADRs, and the code. Do not duplicate rationale — link down.
- **Anchor claims.** Reference files by path + symbol name (`src/agent/loop.ts:runAgent`) rather than bare line numbers — line numbers rot fast.
- **Ship docs with code.** If a PR changes a subsystem, the matching `docs/dev/` page updates in the same PR. Stale dev docs are worse than no dev docs.
