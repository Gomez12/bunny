# ADR 0008 — Projects

**Status:** Accepted
**Date:** 2026-04-15

## Context

Until now all conversation state sat in one flat pot: messages scoped on `session_id` (+ `user_id`). As soon as Bunny is used for multiple workloads at once (an R&D chat, an internal support chat, a team wiki) you want per context:

- An own **system prompt** (tone, domain knowledge, restrictions).
- Isolated **recall** — no cross-pollination between contexts.
- Later per context: skills, prompt shortcuts, wiki files.
- Visibility as a first-class thing in the UI ("go to project X").

This ADR introduces the **project** concept: a logical workspace with both a DB row (metadata) and its own directory on disk.

## Decision

1. **Project = session attribute, stored per message.** Every `messages` row gets a `project` column. A session belongs to exactly one project; that is derived from any arbitrary row of that session. Switching projects in the UI always starts a new session.
2. **Default project `general`.** On every DB open it is set via `INSERT OR IGNORE`. Legacy/NULL-project rows read back as `general` via `COALESCE(project, 'general')` in every read.
3. **Append-only migration.** Only `ALTER TABLE messages ADD COLUMN project TEXT` + new `projects` table + `idx_messages_project`. No backfill; NULL stays NULL.
4. **On-disk directory = source of truth for prompt text.** Each project has `$BUNNY_HOME/projects/<name>/systemprompt.toml` with fields `prompt` and `append` (bool). The DB holds only metadata (`description`, `visibility`, `created_by`, `created_at`, `updated_at`). PATCH rewrites the TOML — no drift between DB and disk.
5. **`append` flag drives composition.** `append=true` (default): the project prompt comes after the base prompt. `append=false`: the project prompt **replaces** the base prompt entirely (power-user override).
6. **Recall is project-scoped.** `hybridRecall`, `searchBM25` and `searchVector` get an optional `project` parameter. BM25 filters via `COALESCE(m.project,'general') = ?`; vector uses over-fetch + post-filter (vec0 does not support joins in MATCH).
7. **Name = PK and directory — immutable.** A rename implies keeping DB + disk atomic; not worth it. Only `description`, `visibility` and the prompt are editable. Regex: `^[a-z0-9][a-z0-9_-]{0,62}$`, plus denylist (`.`, `..`, `node_modules`, empty).
8. **Visibility prepared, but default public.** `projects.visibility` = `'public'|'private'`, default `'public'`. Public projects are visible and usable by every authenticated user; private projects only by admin + creator. This leaves room for future privacy without introducing complexity now.
9. **CLI `--project <name>` auto-creates.** Unknown name → DB row + `projects/<name>/systemprompt.toml` stub. With `--session <existing>` + a `--project` that doesn't match: hard error (one project per session).
10. **HTTP: `/api/projects` (CRUD) + `?project=` on `/api/sessions` + `project` in the `/api/chat` body.** Mismatch between body project and existing session → 409.
11. **Configurable defaults.** The name of the default project and the base system prompt live under `[agent]` in `bunny.config.toml` (`default_project`, `system_prompt`; env: `BUNNY_DEFAULT_PROJECT` / `BUNNY_SYSTEM_PROMPT`). `runAgent` takes them via `agentCfg`; at boot both the CLI and the server seed the configured default project alongside the permanently present `general`. That way `general` remains the stable legacy fallback in SQL (`COALESCE(project,'general')`) while a team can pick its own "workspace" name.

## Consequences

- **No backfill runbook**: existing `.bunny` directories keep working, everything from before this commit automatically looks like `general`.
- **Recall smaller and more targeted** — "general" doesn't drown in mixed context.
- **Future per-project assets** (skills, shortcuts, wiki) only need to extend `loadProjectAssets(name)`; the system-prompt pipeline is already ready to carry extra fields.
- **Session ↔ project binding is implicit** via messages. `runAgent` + `/api/chat` guard against a project mismatch; the web UI starts a new session on project switch for safety.

## Alternatives

- *Project on the `sessions` table*: we don't have a `sessions` table; one-per-message keeps the migration trivial and makes queries (recall, listSessions, sidebar) a simple WHERE clause.
- *Prompt text in the DB*: would add a second storage location next to the TOML. As is, the TOML is editable from disk as well as from the web UI — one source.
- *Projects as bunny-config fields*: too static; users want to create them at runtime in the web UI.

## Verification

- `bun test tests/memory/projects.test.ts` — 10 tests (CRUD, validation, default seed, `getSessionProject`, NULL legacy).
- `bun test tests/memory/project_scoping.test.ts` — BM25 and `listSessions` scoping.
- `bun test tests/agent/prompt.test.ts` — append vs. replace, legacy positional call.
- End-to-end: web UI Projects tab → create → card click → chat answers per the project instructions → Messages tab filters on project.
