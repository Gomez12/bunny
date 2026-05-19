# Authentication

## At a glance

Three primitives: **users** (password-auth humans), **auth_sessions** (cookie-backed browser sessions), and **api_keys** (bearer tokens for the CLI). `src/server/auth_middleware.ts:authenticate` accepts either.

Roles are simple: `admin` or `user`. Admins see everything; users see only their own sessions + public entities + entities they created.

## Where it lives

- `src/auth/users.ts` — user CRUD, role checks, `getUserByUsernameCI`.
- `src/auth/sessions.ts` — cookie-backed sessions (`bunny_session`).
- `src/auth/apikeys.ts` — mint, hash, lookup, revoke.
- `src/auth/password.ts` — `Bun.password` (argon2id) wrappers.
- `src/auth/seed.ts` — seeds the admin + `system` user at boot.
- `src/server/auth_middleware.ts:authenticate` — the entry point for every `/api/*` request.
- `src/server/auth_routes.ts` — `/api/auth/*`, `/api/users*`, `/api/apikeys*`.

## Schema

```sql
CREATE TABLE users (
  id             TEXT PRIMARY KEY,
  username       TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,          -- Bun.password (argon2id)
  role           TEXT NOT NULL DEFAULT 'user',   -- 'admin' | 'user'
  display_name   TEXT,
  email          TEXT,
  must_change_pw INTEGER NOT NULL DEFAULT 0,
  expand_think_bubbles INTEGER NOT NULL DEFAULT 0,
  expand_tool_bubbles  INTEGER NOT NULL DEFAULT 0,
  preferred_language   TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE auth_sessions (
  token      TEXT PRIMARY KEY,                        -- opaque, random
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL
);

CREATE TABLE api_keys (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,                  -- only the hash is stored
  prefix       TEXT NOT NULL,                         -- shown to users for disambiguation
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER,
  last_used_at INTEGER,
  revoked_at   INTEGER
);
```

## Resolution order

`authenticate` tries in this order:

1. `Authorization: Bearer bny_<rest>` → hash → `api_keys` lookup. On hit, `last_used_at` is bumped.
2. `Cookie: bunny_session=<token>` → `auth_sessions` lookup → check expiry → bump `last_seen`.
3. No match → return `null`. The route switch answers `401` for most routes; a few (webhooks) are mounted *before* the auth gate.

API keys start with `bny_` so they're recognisable in logs. The full key is shown once at mint time and never retrievable again — only the hash is stored.

## Cookie mechanics

- `bunny_session` is HTTP-only, `SameSite=Lax`, set on successful login and on change-password.
- Expiry is refreshed on every authenticated request.
- Logout calls `closeAllFor(userId)` on the notifications fanout so open SSE streams hang up.
- The frontend uses `credentials: "include"` on every fetch so the cookie rides along.

## Seeding

`startServer` seeds two users at boot:

- **Admin** — username from `cfg.auth.defaultAdmin.username`, password from `$BUNNY_DEFAULT_ADMIN_PASSWORD` (default `admin`). `must_change_pw = 1` so the first login forces a password change.
- **`system`** — the owner for CLI actions that don't carry a `BUNNY_API_KEY`. `role = 'user'`; used purely for attribution.

Seeding is idempotent — existing rows are left alone.

## Scope helpers

Project and entity endpoints use a consistent set of helpers:

- `canSeeProject(db, user, project)` — admin OR public project OR creator.
- `canEditProject(db, user, project)` — admin OR creator.
- `canEditCard(db, user, card)` — admin OR project-owner OR creator OR user-assignee. See `src/memory/board_cards.ts`.
- `canEditDocument` / `canEditWhiteboard` / `canEditDefinition` — admin OR creator.

Non-admins receive only their own sessions from `listSessions` and `/api/sessions/:id/messages`.

## Key invariants

- **Bearer before cookie.** CLI runs should never accidentally pick up a cookie from a dev browser in the same environment.
- **Admin visibility is global; mutation requires ownership.** A non-admin can *see* a public project but can only *edit* one they created. Card assignees are the exception — they can edit the card they've been handed.
- **Password and key hashes never leave the DB.** Responses carry only the prefix + metadata.
- **API key mint is one-shot.** Losing a key means revoke + re-mint; there's no "reveal" endpoint.

## Gotchas

- `must_change_pw = 1` blocks every `/api/*` route except `/api/auth/change-password`. The frontend reads the `mustChangePassword` flag from `/api/auth/me` and routes to the change-password page.
- Webhook endpoints (Telegram) are mounted *before* `authenticate` — they use a constant-time compare against a per-project secret. Getting the order wrong either breaks the webhook or exposes it.
- A user's `preferred_language` overrides the project default — relevant for the translation UI (see `../concepts/translation-pipeline.md`) but not for auth itself.

## Related

- [ADR 0007 — Authentication, users, roles, API keys](../../adr/0007-auth-and-users.md)
- [`../entities/integrations.md`](../entities/integrations.md) — API key management UI.
- [`projects-as-scope.md`](./projects-as-scope.md) — what scope a given `userId` + `project` grants.
