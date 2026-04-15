# ADR 0007 — Authentication, users, roles and API keys

**Status:** Accepted
**Date:** 2026-04-14

## Context

Until now Bunny ran stateless-per-user: anyone with network access could call the web UI and CLI, and all messages/sessions sat in one global pot. For multi-user use (team, daily use on one server) authentication is needed, including:

- Login in the web UI and persistence of the login.
- Roles (admin vs regular user) — one admin manages the rest.
- Programmatic access (CLI, scripts) without every shell prompting for a password.
- History (messages) linked to a user so everyone sees their own conversations.

## Decision

1. **Users in SQLite.** New append-only tables `users`, `auth_sessions`, `api_keys`. `messages`/`events` get a `user_id` column (nullable, since legacy rows have no owner).
2. **Password hashing:** `Bun.password` (argon2id). No npm deps.
3. **Web login:** POST `/api/auth/login` returns an HTTP-only cookie `bunny_session` that server-side maps to a random token in `auth_sessions`. TTL from `[auth] session_ttl_hours` (default 7 days). Logout = delete the row.
4. **CLI / bearer auth:** per-user API keys with optional expiry and a human name. Format `bny_<8 hex prefix>_<32 hex secret>`. Only `sha256(key)` is stored; the plaintext is shown once at creation. On the CLI you read it via `BUNNY_API_KEY` env or `--api-key`. No key → the CLI falls back to the seeded `system` user (backward-compat).
5. **Seeded admin:** if `users` is empty at boot the server creates an admin based on `[auth] default_admin_username` / `default_admin_password` (env: `BUNNY_DEFAULT_ADMIN_PASSWORD`). That user gets `must_change_pw=1`; the first login forces a password change before chat unlocks.
6. **Scoping:** non-admin users only see their own sessions (filter on `user_id` in `listSessions`/`getMessagesBySession`). Admins see everything. Legacy sessions without `user_id` stay visible to everyone (read-only fallback).

## Rationale

- **Cookie + DB token, no JWT.** Server-side sessions are directly revokable (logout, admin reset) and require no signing secret in config. The same SQLite DB remains the single source of truth.
- **Keys hashed, prefix visible.** The prefix (`bny_ab12…`) is enough to recognise a key in a list without showing the plaintext secret again. A leaked key can be revoked with one click in the web UI.
- **`system` user as fallback.** Prevents existing CLI scripts from breaking after this upgrade. The user has a random unusable password, so there is no way in via login.
- **Append-only schema.** Per existing convention: we add columns (`user_id`) and tables, nothing is renamed/removed — so an existing `$BUNNY_HOME` works without migration pain.
- **Middleware in one place.** `src/server/auth_middleware.ts` first tries bearer, then cookie; all `/api/*` routes except `/api/auth/login` run through `requireAuth`.

## Data-flow

```
Browser ──POST /api/auth/login {user,pass}──► Bun.serve
                                                │
                                                ▼
                                  issueSession → DB row + Set-Cookie
                                                │
                           Subsequent /api/* requests ──Cookie──► authenticate()
                                                                    │
                                                      user bound to runAgent({userId})
                                                                    │
                                                   insertMessage stamps user_id
```

CLI:
```
bun run src/index.ts "…"                    → system user
BUNNY_API_KEY=bny_… bun run src/index.ts "…" → validateApiKey → real user
```

## Consequences

- `bunny.config.toml` gains an `[auth]` section; `.env` only for secrets (`BUNNY_DEFAULT_ADMIN_PASSWORD`, `BUNNY_API_KEY`).
- CORS echoes the caller origin and sets `Allow-Credentials: true` (wildcard origin is no longer allowed with credentials).
- Frontend on mount requests `GET /api/auth/me`. 401 → login page. `mustChangePassword` → password-change page. Only after that is the regular UI visible. A new Settings tab contains *Profile*, *API keys* and *Users* (admin only).
- The owner filter on sessions is a soft check: admins see everything; legacy sessions remain readable so no history is lost.

## Non-goals

- SSO, OAuth, OIDC, MFA — later, via a separate provider piece alongside the local password flow.
- Per-tool permissions (e.g. "this user cannot use `shell`") — out of scope; roles are coarse (admin/user) until there is a concrete use case.
- Audit log UI for admins. Events already live in the queue (`events` table) but there is no list view for admins yet.
