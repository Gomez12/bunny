# ADR 0031 — Every chat turn is bound to a named agent

Status: Accepted — 2026-04-21

## Context

Until now a chat turn could run without a named agent — `messages.author = NULL`
stood in for "default assistant". The web UI rendered that as the literal word
`assistant`, and user turns as the literal word `user`. Neither reflects a
real identity, and the NULL-author path blocked two things we wanted:

1. Attributing every turn to a recognisable persona (so legacy chats, agent
   sessions, and future-agent turns render uniformly).
2. Letting users pick an agent per session without forcing them to type
   `@name` on every single turn.

`messages.author` is append-only per `CLAUDE.md`, so we can't rewrite history
to retroactively stamp legacy rows. And we want this to work for brand-new
installs without operator setup, so the default agent has to be seeded at
boot.

## Decision

- Every new chat turn resolves to a **named agent** before `runAgent` runs.
  The fallback happens **in the `/api/chat` route**, not in `runAgent` itself —
  unit tests can still construct `runAgent({ agent: undefined })` and write
  NULL-author rows.
- A **configurable default agent** (`cfg.agent.defaultAgent`, env
  `BUNNY_DEFAULT_AGENT`, default `"bunny"`) is seeded at server + CLI boot by
  `ensureDefaultAgent` (`src/memory/agents_seed.ts`) and auto-linked to every
  existing project. `POST /api/projects` links it automatically on creation.
- The seeded agent's on-disk `config.toml` uses **`append = true`** and a
  minimal body (`"You are a helpful assistant"`) so a project's existing
  `systemprompt.toml` overrides keep applying. This preserves the behaviour
  operators already tuned; without `append = true` the flip from "no agent =
  base + project" to "default agent replaces everything" would silently drop
  per-project prompts.
- The **UI substitutes labels at render time**, not in the DB. User bubbles
  show `displayName || username || "you"`; assistant bubbles show `@<author>`,
  falling back to `@<configured default>` for legacy NULL rows. Nothing is
  rewritten. The helper lives in `web/src/lib/messageLabel.ts` and the default
  agent name flows through a React context seeded from `/api/auth/me`.
- Users pick a non-default agent via **two affordances**:
  - A **Composer agent picker** — persisted per session in
    `localStorage["bunny.activeAgent.<sessionId>"]`, forwarded as `agent` in
    the `/api/chat` body.
  - A sidebar **"New chat with…"** entry that starts a fresh session
    pre-bound to the picked agent (client-side only — the first `POST
    /api/chat` carries the binding).
- **Regenerate inherits the responding agent** from the target row (assistant:
  its own `author`; user target: the next assistant's author). Falls back to
  the configured default for legacy NULL chains. Previous behaviour silently
  dropped the author.

## Consequences

### Positive

- Every new turn has a recognisable author. Legacy rows uniformly re-label in
  the UI without a schema touch.
- Operators can rename / override the default agent (or point to a different
  seeded persona) without code changes.
- The Composer picker removes the need to type `@name` on every turn, and
  persists across reloads without any backend state.
- Regenerate no longer silently demotes `mia`'s answer into a NULL-author row.

### Negative / trade-offs

- `bunny` with `append = true` adds ~6 tokens per turn to the system prompt
  (an "Agent instructions" block followed by "You are a helpful assistant").
  Acceptable; the alternative (replace mode) silently loses operator prompts.
- If an operator deletes the `bunny` agent or unlinks it from a project,
  `/api/chat` returns a clear 404/403 rather than silently falling back to
  NULL-author. The boot seeder heals on next restart.
- Every route that used to rely on "no agent = neutral" now resolves to the
  default. Callers that need an agent-less run (KB generate, Whiteboard /
  Document / Contact edit, Code edit/chat, translation handler, web news
  runner, board cards) pass `systemPromptOverride` or an explicit agent and
  are unchanged.

## Invariants (pin these)

- `messages.author` stays append-only. NULL rows stay NULL. The UI
  substitution is the only retroactive change.
- `runAgent({ agent: undefined })` still runs — the fallback is route-level.
- `ensureDefaultAgent` is idempotent and preserves on-disk operator edits
  (`ensureAgentDir` only writes when `config.toml` is missing).
- `context_scope` for the seeded agent stays `"full"` — `"own"` would break
  recall continuity on fresh installs (bunny has no prior rows).
- Background handlers that don't want agent attribution (`systemPromptOverride`
  users) are untouched; subagents via `call_agent` keep their explicit agent.
