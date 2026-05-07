# ADR 0039 — Code-Project Secrets

**Status:** Accepted  
**Date:** 2026-05-07

## Context

Scripts within code-projects routinely need sensitive values: database passwords, API keys, connection strings, OAuth tokens. Before this feature, developers had to either hard-code those values directly into script content (security risk, not reusable) or manage them entirely outside Bunny. Neither is acceptable for a self-hosted tool that is expected to be the authoritative workspace.

## Decision

Add a first-class secrets store scoped to code-projects. Secrets are key-value pairs with two runtime access methods and two protection flags.

### Tag syntax and environment-variable injection

Scripts reference secrets via `{{secret:NAME}}` tags (substituted before the temp file is written) and via `process.env.NAME` (injected into the child-process environment). Both access patterns are supported in parallel so scripts remain idiomatic regardless of language. Monaco IntelliSense covers both forms.

Tag names must match `^[A-Z][A-Z0-9_]*$` — valid both as template identifiers and environment-variable names — enforced at create/update time.

### Substitution at run time, not at rest

`script.content` in the database is never mutated. Substitution happens in `handleRun` immediately before `atomicWrite(tmpAbs, resolvedContent)`, on the in-memory string. The resolved content goes to a temp file that is deleted after execution. Script versions are snapshots of raw content and therefore never contain resolved values.

Unknown tags (`{{secret:NONEXISTENT}}`) cause a hard 422 error with the list of missing tag names rather than silent substitution of empty string — making errors visible immediately instead of letting scripts silently misbehave.

### LLM-forbidden guard

Each secret carries `llm_forbidden` (default `0`). When `1`, the secret's value must never appear in a manual LLM prompt. The guard scans user-typed content synchronously at five HTTP entry points before any queue activity or `runAgent` call:

- `POST /api/chat` (main chat route)
- `POST /api/messages/:id/regenerate`
- `POST /api/code/:id/edit`
- `POST /api/code/:id/chat`
- `POST /api/scripts/:id/chat`

The guard loads all `llm_forbidden=1` values across every non-deleted code-project (cross-project defense-in-depth — a single Bun process serves all projects). It returns HTTP 400 with a generic message that never reveals which secret or its value. Empty values are skipped to prevent false positives.

Automated paths (`originAutomation: true`) are exempt because they never contain user-typed sensitive data.

### Visibility control

`is_viewable` (default `0`) controls whether non-admin project members can read a secret's value via the API. When `0`, the list endpoint returns `value: null` for that secret — non-admins see a masked placeholder in the UI, but the value is not transmitted at all. Admins always receive the plaintext value regardless of `is_viewable`.

### Storage (plaintext in V1)

Values are stored as-is in SQLite. This follows the existing model for `project_telegram_config.bot_token`. The `$BUNNY_HOME` directory is expected to be secured by OS filesystem permissions.

V2 path (if encryption is added): add an `encrypted_value` column alongside `value`, backfill rows, then null out `value` in a background migration. The append-only schema constraint is preserved throughout.

### Audit trail

Each script run logs the names (never values) of secrets that were actually used via tag substitution in the queue event `{ topic: "secrets", kind: "run", data: { usedSecrets: ["NAME", ...] } }`. The `last_used_at` column is bumped on every run that references the secret.

## Consequences

- Admins can now store sensitive values with a UI and reference them in scripts without hard-coding.
- The `{{secret:NAME}}` and `process.env.NAME` patterns are both idiomatic and have Monaco IntelliSense autocomplete.
- A script that references a missing secret fails immediately (422) rather than silently.
- Chat prompts containing a forbidden secret value are blocked before reaching the LLM.
- A short or common value marked `llm_forbidden` could produce false positives in multi-project setups. Document this trade-off in operator notes: do not mark short generic strings as forbidden.
- The `code_project_secrets` table is append-only; future columns (e.g. `encrypted_value`, `expires_at`) are added, not renamed.
