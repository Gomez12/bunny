# ADR 0013 — Agent Skills (agentskills.io standard)

## Status

Accepted — 2026-04-16

## Context

Agents already have system prompts and tool whitelists, but there is no
standard way to share reusable instruction packages across agents and
projects. The [agentskills.io](https://agentskills.io) open standard defines
a lightweight format: a directory containing a `SKILL.md` file with YAML
frontmatter (name, description, license, compatibility, metadata,
allowed-tools) and a markdown body with instructions. Skills can also
bundle `scripts/`, `references/`, and `assets/` subdirectories.

We want to adopt this standard so that:

1. Users can install skills from the growing ecosystem (GitHub repos,
   skills.sh directory).
2. Skills can be managed at both global and project level.
3. The agent loop uses progressive disclosure: lightweight catalog in the
   system prompt, full instructions loaded on demand.

## Decision

### On disk

Skills live at `$BUNNY_HOME/skills/<name>/SKILL.md`. The directory name
matches the `name` field in the frontmatter. Additional files (scripts,
references, assets) live alongside the SKILL.md.

### Database

Two new tables: `skills` (name PK, description, visibility, source_url,
source_ref, created_by, timestamps) and `project_skills` (project, skill
composite PK). Same pattern as `agents` / `project_agents`.

### YAML parsing

SKILL.md uses YAML frontmatter, not TOML. Added `yaml` (npm) as a
runtime dependency. The parser is lenient: malformed YAML falls back to
defaults rather than crashing.

### Progressive disclosure

Three tiers:

1. **Catalog** (~50-100 tokens/skill): name + description injected into
   the system prompt as a section between "Other agents" and "Relevant
   past context".
2. **Instructions** (<5000 tokens): Full SKILL.md body loaded via the
   `activate_skill` tool when the LLM decides a skill is relevant.
3. **Resources**: Scripts, references, and assets loaded on demand by the
   LLM using existing `read_file` / `list_dir` tools.

### activate_skill tool

Closure-bound per-run tool (same pattern as `call_agent`, board tools,
workspace tools). Added to `DYNAMIC_TOOL_NAMES`. The tool validates the
skill name is in the available set, returns the markdown body wrapped in
`<skill_content>` tags, and lists bundled resources in `<skill_resources>`.

### Installation from URL

`installSkillFromGitHub(url)` parses GitHub URLs, fetches the directory
via the GitHub Contents API, and writes files to `$BUNNY_HOME/skills/`.
`installSkillFromSkillsSh(identifier)` resolves skills.sh identifiers to
GitHub URLs and delegates.

### HTTP routes

`/api/skills` (CRUD), `/api/skills/install` (URL install),
`/api/projects/:p/skills` (link/unlink). Mounted in `routes.ts` after
agent routes.

### Web UI

Skills tab with card grid, create dialog, install-from-URL dialog,
project link/unlink checkboxes. Mirrors the Agents tab pattern.

## Consequences

- New `yaml` runtime dependency (small, well-maintained).
- Skills from the open ecosystem can be installed with a URL.
- The activate_skill tool adds one dynamic tool to the registry when
  skills are linked to the active project.
- Skills are passive instruction sets, not autonomous personalities like
  agents. They don't have their own memory knobs or context scope.
