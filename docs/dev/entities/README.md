# Entities

One page per user-facing entity. Each page follows the same shape:

1. **What it is** — user-facing one-liner.
2. **Data model** — tables + key invariants (full DDL lives in `src/memory/schema.sql`).
3. **HTTP API** — endpoint list.
4. **Code paths** — create / read / update / delete / list entry points.
5. **UI** — tab file + key components.
6. **Extension hooks** — translation, trash, notifications, scheduler, tools.
7. **Related** — ADR links.

## Index

- [**chat**](./chat.md) — sessions, messages, Quick Chats, Fork, Edit, Regenerate.
- [**agents**](./agents.md) — named personalities with their own prompt + tool whitelist + memory knobs.
- [**skills**](./skills.md) — reusable instruction packages (agentskills.io).
- [**boards**](./boards.md) — per-project Trello-style kanban with agent-runnable cards.
- [**tasks**](./tasks.md) — periodic work via cron; system + user kinds.
- [**documents**](./documents.md) — per-project rich-text documents (Tiptap + markdown).
- [**whiteboards**](./whiteboards.md) — per-project Excalidraw whiteboards with LLM edit/ask modes.
- [**files**](./files.md) — per-project workspace file browser.
- [**contacts**](./contacts.md) — per-project contact cards with groups and vCard import/export.
- [**knowledge-base**](./knowledge-base.md) — per-project dictionary of project-specific terms (manual + LLM short/long + SVG).
- [**web-news**](./web-news.md) — per-project periodic news aggregator.
- [**workflows**](./workflows.md) — per-project TOML-defined DAG pipelines with `prompt` / `bash` / `loop` / `interactive` nodes.
- [**code**](./code.md) — per-project source-code areas (Show Code / Chat / Graph) on a secondary icon rail.
- [**dashboard**](./dashboard.md) — KPIs, time-series charts, error rates, activity feed.
- [**integrations**](./integrations.md) — per-project Telegram bot + API key management.
