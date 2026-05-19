# Projects as scope

## At a glance

Projects are the top-level scope key. Every user-facing entity (sessions, messages, boards, documents, whiteboards, files, contacts, KB definitions, web news topics, agent/skill links) carries a `project` column. Recall, search, and every CRUD query filter by project. Nothing leaks across projects.

A project has two sources of truth:

- **DB row** — metadata (name PK, description, visibility, languages, default_language, created_by, timestamps).
- **On-disk directory** — `$BUNNY_HOME/projects/<name>/` with `systemprompt.toml` (prompt + append flag) and `workspace/input/` + `workspace/output/`.

The project name is the primary key *and* the directory name. It is immutable; only description / visibility / system prompt can change.

## Where it lives

- `src/memory/projects.ts` — DB CRUD + `validateProjectName` + `getSessionProject`.
- `src/memory/project_assets.ts` — `ensureProjectDir`, `loadProjectSystemPrompt`, `writeProjectSystemPrompt`.
- `src/agent/prompt.ts:buildSystemMessage` — system-prompt composition.
- `src/server/project_routes.ts` — `/api/projects*`.

## Lifecycle

```
POST /api/projects { name, description, visibility }
   │
   ├─► validateProjectName    (lowercase + dash/underscore, no path separators)
   ├─► insertProject          (DB row)
   ├─► ensureProjectDir       (creates workspace/input, workspace/output)
   ├─► seed default board swimlanes (Todo / Doing / Done)
   └─► queue.log({ topic: "project", kind: "create" })
```

`PATCH /api/projects/:name` updates description, visibility, languages, default_language, or the on-disk prompt (via `writeProjectSystemPrompt`). It also calls `backfillTranslationSlotsForProject` when `languages` grows.

`DELETE` drops the row; the directory is left on disk for recovery.

## The default project

- CLI boot (`src/index.ts`) and `startServer` both seed:
  - `general` — always exists.
  - `cfg.agent.default_project` — configurable via `bunny.config.toml` `[agent].default_project` or `BUNNY_DEFAULT_PROJECT`.
- Legacy `messages` rows with NULL project are read back as `'general'` via `COALESCE(project, 'general')`.
- `runAgent` errors on a session locked to one project when a different project is requested.

## System prompt composition

`buildSystemMessage` stacks:

```
base prompt   (cfg.agent.system_prompt → src/agent/prompt.ts fallback)
   +
project prompt  (from systemprompt.toml, append=true by default)
   +
agent prompt    (wins over project; default append=false = replace)
   +
skills catalog  (~50-100 tokens/skill — see entities/skills.md)
   +
hybrid recall   (top-k messages via RRF over BM25 + vec)
```

Precedence for memory knobs (`last_n`, `recall_k`): **agent → project → global**. `runAgent` reads these on each call; they're not cached.

## Scope helpers

- `canSeeProject(db, user, project)` — admin OR `visibility = 'public'` OR `created_by = user.id`.
- `canEditProject(db, user, project)` — admin OR `created_by = user.id`.

Entity-level helpers (`canEditDocument`, `canEditCard`, etc.) layer on top — see `auth.md`.

## Opt-in linking

Some entities are *global* with per-project opt-in, not per-project-owned:

- `agents` + `project_agents`
- `skills` + `project_skills`

Others are strictly per-project:

- `boards` (the `project` column on `board_swimlanes`, `board_cards`)
- `documents`, `whiteboards`, `contacts`, `contact_groups`, `kb_definitions`, `web_news_topics`, `web_news_items`
- `workspace/*` (filesystem)

See each entity page for the exact shape.

## Key invariants

- **Name is immutable** (PK + directory name).
- **Every entity row carries `project`.** The grep `FROM (messages|documents|whiteboards|contacts|kb_definitions|board_cards|web_news_topics)\b` without `AND project = ?` should fail review.
- **A session is locked to one project.** `messages.project` and `boards` queries key off the same value; mismatches throw.
- **Recall is project-scoped.** `hybridRecall` takes `project` as a mandatory argument.

## Gotchas

- `validateProjectName` is strict (lowercase, dashes/underscores, no path separators). A project named `Foo Bar` will be rejected; reserve display names for the `description` field.
- Dropping a project DB row does not delete the directory on disk. This is deliberate — recovery-friendly but adds housekeeping. An admin action to hard-delete the directory is not wired in v1.
- `languages` is a JSON array; expansion (adding a language) triggers `backfillTranslationSlotsForProject` so existing entities get pending sidecars. Shrinking leaves orphaned sidecars in place (see `translation-pipeline.md`).
- `cfg.agent.default_project` creates a second default on top of `general`. Tests that assume `general` is the only pre-seeded project will fail — they should set `BUNNY_DEFAULT_PROJECT=general`.

## Related

- [ADR 0008 — Projects](../../adr/0008-projects.md)
- [`agent-loop.md`](./agent-loop.md) — how the project flows through `runAgent`.
- [`memory-and-recall.md`](./memory-and-recall.md) — project as a recall filter.
- [`translation-pipeline.md`](./translation-pipeline.md) — per-project `languages` list.
- [`../entities/chat.md`](../entities/chat.md) — sessions, the project-aware surface.
