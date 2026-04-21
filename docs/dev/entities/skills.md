# Skills

## What it is

Reusable instruction packages following the [agentskills.io](https://agentskills.io) open standard. A skill is a directory with a `SKILL.md` (YAML frontmatter + markdown instructions) plus optional `scripts/`, `references/`, `assets/`. Skills are **passive**: no memory knobs, no context scope — they're just instructions the agent can activate on demand.

Progressive disclosure: the catalog (name + description per skill, ~50-100 tokens each) is always in the system prompt. The full body loads only when the LLM calls the `activate_skill` tool.

## Data model

```sql
CREATE TABLE skills (
  name        TEXT    PRIMARY KEY,
  description TEXT    NOT NULL DEFAULT '',
  visibility  TEXT    NOT NULL DEFAULT 'private',
  source_url  TEXT,           -- when installed from a URL
  source_ref  TEXT,           -- git ref
  created_by  TEXT    REFERENCES users(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE project_skills (
  project  TEXT NOT NULL,
  skill    TEXT NOT NULL,
  PRIMARY KEY (project, skill)
);
```

On-disk: `$BUNNY_HOME/skills/<name>/SKILL.md`. YAML frontmatter (not TOML — the agentskills.io standard specifies YAML).

## HTTP API

- `GET /api/skills` — list.
- `POST /api/skills` — create (manual).
- `POST /api/skills/install` — install from a URL (GitHub tree/blob or skills.sh identifier).
- `GET/PATCH/DELETE /api/skills/:name` — CRUD.
- `GET /api/projects/:p/skills` — linked skills.
- `POST /api/projects/:p/skills` — link.
- `DELETE /api/projects/:p/skills/:skill` — unlink.

## Code paths

- `src/memory/skills.ts` — CRUD + link helpers.
- `src/memory/skill_assets.ts` — SKILL.md parsing (`yaml` npm package) + mtime cache.
- `src/memory/skill_install.ts` — GitHub + skills.sh fetcher.
- `src/tools/activate_skill.ts` — closure-bound tool, same pattern as `call_agent`. Added to `DYNAMIC_TOOL_NAMES` in `loop.ts`.
- `src/server/skill_routes.ts`.

## UI

- `web/src/tabs/SkillsTab.tsx` — card grid + create dialog + install-from-URL dialog.
- `web/src/components/SkillDialog.tsx`.
- Project link/unlink checkboxes.

## Extension hooks

- **Translation:** no.
- **Trash:** no.
- **Notifications:** no.
- **Scheduler:** no.
- **Tools:** `activate_skill` is a per-run closure-bound tool. It's not in the static registry — it's spliced in by `buildRunRegistry`.

## Progressive disclosure mechanics

1. **Catalog** — for each linked skill, `buildSystemMessage` emits a line `- <name>: <description>`. Tiny token cost.
2. **Activation** — the LLM decides to call `activate_skill(name)`. The tool returns the full SKILL.md body wrapped in `<skill_content>` tags plus a `<skill_resources>` listing of bundled files.
3. **Bundled files** — loaded on demand via the existing `read_file` tool. No new primitives required.

## Installing from a URL

`POST /api/skills/install` accepts:

- GitHub tree URL: `https://github.com/owner/repo/tree/ref/path/to/skill` — fetches via the Contents API.
- GitHub blob URL: `https://github.com/owner/repo/blob/ref/path/SKILL.md` — fetches the directory above.
- skills.sh identifier: resolved to GitHub via the skills.sh redirect.

The fetcher writes the files to `$BUNNY_HOME/skills/<name>/`, creates the DB row with `source_url` + `source_ref`, and returns the new skill.

## Key invariants

- **SKILL.md uses YAML frontmatter.** Elsewhere the project uses TOML — skills are the exception because the standard says so.
- **Skills are passive.** No memory knobs, no context scope, no prompt precedence. They're activated on demand.
- **Catalog is always in the system prompt.** Activation loads the body; the catalog stays.
- **Name is PK + directory name.** Immutable.

## Gotchas

- `activate_skill` is dynamic and has to be on `DYNAMIC_TOOL_NAMES` in `loop.ts` to surface via `/api/tools`.
- Scripts bundled with a skill don't auto-execute — the agent has to explicitly read and interpret them via the existing `read_file` tool. Don't add a separate "run skill script" primitive.
- Renaming a skill means delete + recreate (PK immutability). Bumping via install-from-URL keeps the same name.
- The install endpoint is un-authenticated against the source — users can install any public GitHub skill. Treat that as a trust boundary when shipping to production.

## Related

- [ADR 0013 — Agent skills](../../adr/0013-agent-skills.md)
- [`./agents.md`](./agents.md) — same opt-in linking pattern via `project_agents` vs `project_skills`.
- [`../how-to/add-a-tool.md`](../how-to/add-a-tool.md) — `activate_skill` is a closure-bound tool like `call_agent`.
