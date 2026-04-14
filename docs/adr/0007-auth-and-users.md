# ADR 0007 — Authenticatie, users, rollen en API keys

**Status:** Accepted
**Datum:** 2026-04-14

## Context

Tot nu toe draaide Bunny stateless-per-user: iedereen met netwerktoegang kon de web UI en CLI aanroepen, en alle messages/sessions zaten in één globale pot. Voor multi-user gebruik (team, dagelijks gebruik op één server) is authenticatie nodig, inclusief:

- Login in de web UI en persistentie van de login.
- Rollen (admin vs gewone user) — één admin beheert de rest.
- Programmatische toegang (CLI, scripts) zonder dat iedere shell een wachtwoord vraagt.
- Historie (messages) te koppelen aan een user zodat iedereen zijn eigen gesprekken ziet.

## Beslissing

1. **Users in SQLite.** Nieuwe append-only tabellen `users`, `auth_sessions`, `api_keys`. `messages`/`events` krijgen een `user_id` kolom (nullable, want legacy rows hebben geen eigenaar).
2. **Wachtwoord-hashing:** `Bun.password` (argon2id). Geen npm-deps.
3. **Web login:** POST `/api/auth/login` levert een HTTP-only cookie `bunny_session` dat server-side naar een random token in `auth_sessions` verwijst. TTL uit `[auth] session_ttl_hours` (default 7 dagen). Logout = rij verwijderen.
4. **CLI / bearer auth:** per user aan te maken API keys met optionele expiry en menselijke naam. Format `bny_<8 hex prefix>_<32 hex secret>`. Alleen `sha256(key)` wordt opgeslagen; de plaintext is één keer zichtbaar bij creatie. Op de CLI lees je via `BUNNY_API_KEY` env of `--api-key`. Geen key → de CLI valt terug op de geseedde `system` user (backward-compat).
5. **Seeded admin:** als `users` leeg is bij boot maakt de server een admin aan op basis van `[auth] default_admin_username` / `default_admin_password` (env: `BUNNY_DEFAULT_ADMIN_PASSWORD`). Die user krijgt `must_change_pw=1`; eerste login forceert een wachtwoordwissel voordat de chat vrijkomt.
6. **Scoping:** niet-admin users zien alleen eigen sessies (filter op `user_id` in `listSessions`/`getMessagesBySession`). Admins zien alles. Legacy sessies zonder `user_id` blijven voor iedereen zichtbaar (read-only fallback).

## Onderbouwing

- **Cookie + DB-token, géén JWT.** Server-side sessies zijn direct revokeable (logout, admin reset) en vergen geen signing-secret in de config. Dezelfde SQLite-DB blijft de single source of truth.
- **Keys gehashd, prefix zichtbaar.** De prefix (`bny_ab12…`) is genoeg om een key in een lijst te herkennen zonder het plaintext-secret opnieuw te hoeven tonen. Een gelekte key kan met één klik in de web UI worden ingetrokken.
- **`system` user als fallback.** Voorkomt dat bestaande CLI-scripts breken na deze upgrade. De user heeft een random unusable password, dus er is geen weg via login naar binnen.
- **Append-only schema.** Conform bestaande conventie: we voegen kolommen toe (`user_id`) en tabellen, niets wordt hernoemd/verwijderd — zodat een bestaande `$BUNNY_HOME` zonder migratie-pijn werkt.
- **Middleware in één plek.** `src/server/auth_middleware.ts` probeert eerst bearer, dan cookie; alle `/api/*` routes behalve `/api/auth/login` draaien door `requireAuth`.

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

## Consequenties

- `bunny.config.toml` krijgt een `[auth]`-sectie; `.env` alleen voor secrets (`BUNNY_DEFAULT_ADMIN_PASSWORD`, `BUNNY_API_KEY`).
- CORS echoot de caller-origin en zet `Allow-Credentials: true` (wildcard origin mag niet meer met credentials).
- Frontend vraagt bij mount `GET /api/auth/me`. 401 → login-pagina. `mustChangePassword` → wachtwoord-wijzigen-pagina. Pas daarna is de gewone UI zichtbaar. Nieuwe Settings-tab bevat *Profile*, *API keys* en *Users* (alleen admin).
- De eigenaar-filter op sessies is een softe check: admins zien alles; legacy sessies blijven leesbaar om geen history te verliezen.

## Niet-doelen

- SSO, OAuth, OIDC, MFA — later, via een apart provider-stukje naast de lokale wachtwoord-flow.
- Permissies per tool (bijv. "deze user mag `shell` niet") — uit scope; rollen zijn grof (admin/user) tot er concreet een gebruiksgeval is.
- Audit-log UI voor admins. Events zitten al in de queue (`events` tabel) maar er is nog geen lijst-view voor admins.
