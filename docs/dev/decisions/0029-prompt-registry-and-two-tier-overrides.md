# ADR 0029 — Prompt registry with two-tier overrides

Status: Accepted — 2026-04-20

## Context

Before this ADR Bunny kept its LLM prompts in three different places, and
only two of them were editable without a rebuild:

1. `cfg.agent.systemPrompt` (`[agent] system_prompt` in
   `bunny.config.toml`) — base prompt for every chat turn.
2. `cfg.translation.systemPrompt` (`[translation] system_prompt`) — prompt
   for the translation scheduler.
3. **Every other prompt** lived as hardcoded template literals in the
   handlers that use them: KB definition generation, KB SVG illustration,
   document / whiteboard / contacts edit modes, Web News fetching and
   term renewal, the three per-run tool descriptions (`ask_user`,
   `call_agent`, `activate_skill`), and the system-prompt fragments
   `buildSystemMessage` splices in when peer agents, skills, or
   `ask_user` are available.

Editing the hardcoded set required a code change + redeploy. Two concrete
requests made that painful enough to fix:

- An admin wanted to tune tone / length / JSON-output shape of Bunny's
  content assistants without shipping a new binary.
- A project owner wanted per-project flavours — e.g. a KB definition
  prompt that speaks French, or a web-news prompt that always prefers
  European sources — without forking the code.

## Decision

Extract every hardcoded prompt into a central registry with a two-tier
override model and a UI-driven edit surface.

### Registry

`src/prompts/registry.ts` declares 13 `PromptDef` entries. Each carries:

- `key` — stable dotted id (`kb.definition`, `tools.ask_user.description`,
  …). Serves as the TOML key and the UI row id.
- `scope` — `global` (admin-only, sent on every turn across every
  project) or `projectOverridable` (admin + project creator, scoped to
  one project).
- `description` — short operator-facing help.
- `defaultText` — byte-identical copy of what the call site used to
  hardcode. `tests/prompts/fixtures/` freezes every entry as a `.txt`
  file; snapshot tests compare the two so accidental edits trip a test
  before review.
- `variables` — documented `{{name}}` placeholders callers feed into
  `interpolate`.
- `warnsJsonContract` / `warnsTokenCost` — UI hints that surface a red
  or yellow banner next to the editor (parser risk vs per-turn token
  cost).

### Resolver

`src/prompts/resolve.ts:resolvePrompt(key, { project? })` walks a fixed
fallback chain:

1. Per-project override (`$BUNNY_HOME/projects/<name>/prompts.toml`).
2. Global override (`[prompts]` block in `bunny.config.toml`).
3. `PROMPTS[key].defaultText`.

Both override sources are mtime-cached so admin / project edits take
effect on the next LLM turn without a restart. Template substitution is
a separate `interpolate(template, vars)` call: the resolver never
interpolates — callers stay in control of escaping and conditional
composition (e.g. Web News composes renew+fetch by concatenation).

### Storage

- **Global**: a new `[prompts]` block in the existing
  `bunny.config.toml`. The reader (`src/prompts/global_overrides.ts`)
  is independent of `loadConfig` (which runs once at startup); PUTs
  strip + re-emit only the `[prompts]` section so every other block
  and its comments survive.
- **Per-project**: a new sibling `prompts.toml` under
  `$BUNNY_HOME/projects/<name>/`. **Not** a subtable of
  `systemprompt.toml` — the prompt keyspace is growing, so isolation
  keeps the mtime cache clean and avoids rewriting memory overrides on
  every prompt save. Lazy-seeded: a project never owns the file until
  someone first overrides a prompt. Module:
  `src/memory/prompt_overrides.ts`, mirroring `project_assets.ts`.
- **Multi-line TOML quirk**: Bun's TOML parser does not trim the
  newline immediately following `"""` (contra the spec). The
  serialisers in both override files emit the body on the same line as
  the opening delimiter so round-trips preserve byte-for-byte content.

### HTTP surface

`src/server/prompt_routes.ts`, mounted before `/api/config/ui`:

- `GET  /api/config/prompts` — admin only. Returns every prompt with
  `{ key, scope, description, defaultText, variables, warnsJsonContract,
  warnsTokenCost, global, override, effective, isOverridden }`.
- `PUT  /api/config/prompts` — admin only. Body `{ key, text }`; `text:
  null` clears the override.
- `GET  /api/projects/:name/prompts` — admin or project creator. Same
  shape, filtered to `projectOverridable` keys.
- `PUT  /api/projects/:name/prompts` — admin or project creator.

Every PUT logs through the queue under `topic: "prompts"`
(`kind: global.set | project.set`, payload includes `cleared: true` /
`length`). A 64 KiB upper bound per prompt rejects pathological payloads.

### UI

- **Settings → Prompts** (admin-only sub-tab) — list grouped by
  namespace (`kb.*`, `tools.*`, `agent.*`, `document.*`, `whiteboard.*`,
  `contact.*`, `web_news.*`). Each row has a monospace textarea, Save,
  Reset-to-default, variables chip, and the two warning banners.
- **Project dialog → Prompt overrides** — collapsible section in edit
  mode; lazy-loads on first open. Each `projectOverridable` row has an
  "Inherit" toggle + textarea + Save + "Revert to global" button when
  a project override exists.

### Call-site swaps

Every handler imports the registry instead of declaring a local constant:

| File | Replaces |
|---|---|
| `src/server/kb_routes.ts` | `DEFINITION_SYSTEM_PROMPT`, `ILLUSTRATION_SYSTEM_PROMPT` |
| `src/server/document_routes.ts` | `EDIT_SYSTEM_PROMPT` |
| `src/server/whiteboard_routes.ts` | `EDIT_SYSTEM_PROMPT` |
| `src/server/contact_routes.ts` | `EDIT_SYSTEM_PROMPT` |
| `src/web_news/run_topic.ts` | inline `buildUserMessage` template |
| `src/tools/ask_user.ts` | `ASK_USER_DESCRIPTION` |
| `src/tools/call_agent.ts` | `CALL_AGENT_DESCRIPTION` |
| `src/tools/activate_skill.ts` | `ACTIVATE_SKILL_DESCRIPTION` |
| `src/agent/prompt.ts` | inline peer-agents / skills / ask_user fragments |

Tool descriptors resolve inside `buildRunRegistry`, which runs once per
turn — so mtime-cached overrides propagate automatically without a
dedicated cache-busting hook.

## Alternatives considered

- **Store per-project overrides on the `projects` table**: simpler
  multi-user coordination but diverges from the existing on-disk
  project-asset convention and would force a schema migration for
  every prompt added later. Rejected.
- **Reuse `systemprompt.toml`**: adds mtime-cache coupling between
  memory knobs and prompts. Makes every prompt save touch the memory
  file. Rejected in favour of a sibling `prompts.toml`.
- **Env-var escape hatch per prompt**: 13 vars × "override this one
  prompt" is not a real workflow. `BUNNY_SYSTEM_PROMPT` already covers
  the one env-level override that matters.

## Consequences

- Any new prompt added to a handler in the future should register in
  `src/prompts/registry.ts` + ship a fixture file instead of being
  declared inline. The snapshot test fails loudly if a new default
  doesn't have a matching fixture.
- Admins now have a write surface that can change the LLM contract.
  The JSON-contract banner warns about break-parsing risk; we do not
  gate writes with a schema validator (trusted-admin surface).
- Long prompts remain byte-identical for every caller that never
  touches the UI — the registry's fallback path is the same string
  that was hardcoded before this change.
