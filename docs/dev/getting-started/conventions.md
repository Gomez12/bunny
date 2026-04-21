# Conventions

The non-negotiables. If you catch yourself arguing with one of these, stop and read the rationale.

## English only, always

Every artefact written to the repo or GitHub must be English — commit messages, PR descriptions, issue comments, Markdown, code identifiers, code comments, log strings, error messages, test names, TOML/JSON `description` fields, seeded sample data. Chat with the user can follow their language; nothing else can.

Why: the repo is public-facing and the team is multilingual. A Dutch comment in the middle of an English file is a line of invisible debt.

## Append-only schema

`src/memory/schema.sql` is the canonical DDL. Do not drop or rename columns. Add new columns with safe defaults. Existing `$BUNNY_HOME` directories live for months or years — a rename is a breaking migration with no migration path.

If you *must* rename, write an ADR first.

## Every HTTP mutation logs through the queue

```ts
void ctx.queue.log({ topic, kind, userId, data });
```

- **`void`** — fire-and-forget, never `await`. Logging must not block the response.
- **`topic`** — domain noun. Common ones: `project`, `board`, `agent`, `task`, `workspace`, `apikey`, `user`, `session`, `auth`, `document`, `whiteboard`, `contact`, `kb`, `web_news`, `trash`, `telegram`, `notification`.
- **`kind`** — verb or dotted verb. `create`, `update`, `delete`, `card.move`, `login.failed`, `soft.delete`.
- **`userId`** — always when an authenticated user is available. `null` only for anonymous sources.
- **`data`** — no secrets. Passwords, API-key values, bot tokens, webhook secrets are *never* logged. If a token is in scope, log `tokenTail` (last 4 chars) only.

Read + queue routes don't need this (they don't mutate). Every mutation route does.

Deep dive → [`../concepts/queue-and-logging.md`](../concepts/queue-and-logging.md).

## TOML over YAML, `.env` only for secrets

- `bunny.config.toml` for runtime config.
- `.env` for API keys and other secrets.
- Agents / projects / skills configure themselves via TOML files on disk.
- **Exception:** `SKILL.md` uses YAML frontmatter because it follows the agentskills.io standard.

## Tests live under `tests/` mirroring `src/`

- `src/agent/loop.ts` → `tests/agent/loop.test.ts`.
- DB tests: `mkdtempSync` + `openDb(path)` for isolation. Never share a DB handle between tests.
- Pattern: describe the behaviour (`"persists the new value"`), not the function (`"setProjectPriority"`).

## Provider quirks live in `profiles.ts`

Streaming differences (OpenAI, DeepSeek, OpenRouter, Ollama, Anthropic-compat) live in `src/llm/profiles.ts`. `src/llm/adapter.ts` and `src/llm/stream.ts` stay provider-agnostic — no `if (provider === …)` branches outside `profiles.ts`.

## Icons through the barrel

Frontend icons come from `lucide-react`, but *always* through `web/src/lib/icons.ts`. Never import `lucide-react` directly. Add new icons to the barrel first; PRs that bypass the barrel fail review. See [`../ui/icons-and-rabbit.md`](../ui/icons-and-rabbit.md).

## Visual language is canonised in `docs/styleguide.md`

Consult the styleguide before adding UI. Tokens, spacing scale, icon rules, rabbit mascot placements, shared primitives — all there. When a change affects the styleguide (new tokens, new components), update it in the same PR and add a dated entry to its change log.

## ADRs for non-trivial decisions

Architectural choices land in `docs/adr/` with sequential numbering. An ADR is a few paragraphs explaining *what* was decided and *why* — not code, not a tutorial. Subsequent PRs reference the ADR rather than re-litigating the decision.

## Pre-commit checklist

Before every commit:

1. `bun run check` (typecheck + test) — green. A broken or newly-uncovered module must get a test.
2. `README.md` updated if the user-facing workflow changed (new commands, new flags, new runtime requirements).
3. `docs/README.md` and the matching page in `docs/dev/` updated if architecture shifted.
4. ADR added/amended for non-trivial architectural changes.
5. `CLAUDE.md` updated if conventions, build steps, or the high-level architecture shifted.
6. English everywhere (commit, PR, body, trailers, comments, identifiers, log strings, test names).

If tests regress or a user-visible change has no accompanying doc update — fix first, commit after. A commit that breaks these rules is worse than a commit that never landed.

## Where the rules live

- `CLAUDE.md` §Conventions — the authoritative rulebook for the coding agent.
- `docs/styleguide.md` — visual language rules.
- `docs/adr/` — individual architectural decisions and their rationale.
- This file — the human-oriented orientation.

When they disagree: code first, then `CLAUDE.md`, then the rest.
