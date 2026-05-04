# Businesses

## What it is

Per-project organisation entity. Sibling of [Contacts](./contacts.md), M:N linked through `contact_businesses`. Carries the same shape as a contact (emails, phones, socials, tags) plus organisation-specific fields (`domain`, `description`, `website`, `logo`) and the same eight `soul_*` columns. Two creation paths:

1. **Manual** — UI button → `POST /api/projects/:p/businesses` → `source = 'manual'`.
2. **Auto-built** — opt-in per project (`projects.auto_build_businesses = 1`). The `business.auto_build` handler walks alive contacts, derives `(name, domain)` candidates from `company` + email/website domains, and inserts new rows via `INSERT … ON CONFLICT DO NOTHING RETURNING id`. Newly created rows get `soul_next_refresh_at = now` so the soul handler picks them up on its next tick.

See [ADR 0036](../../adr/0036-social-handles-and-businesses.md) for the rationale.

## Data model

```sql
CREATE TABLE businesses (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  project               TEXT    NOT NULL REFERENCES projects(name) ON DELETE CASCADE,
  name                  TEXT    NOT NULL,
  domain                TEXT,
  description           TEXT    NOT NULL DEFAULT '',
  notes                 TEXT    NOT NULL DEFAULT '',
  website               TEXT,
  emails                TEXT    NOT NULL DEFAULT '[]',
  phones                TEXT    NOT NULL DEFAULT '[]',
  socials               TEXT    NOT NULL DEFAULT '[]',
  address               TEXT,                              -- JSON: {street, postalCode, city, region, country}
  address_fetched_at    INTEGER,                           -- last successful auto-fill from soul refresh
  logo                  TEXT,
  tags                  TEXT    NOT NULL DEFAULT '[]',
  soul                  TEXT    NOT NULL DEFAULT '',
  soul_status           TEXT    NOT NULL DEFAULT 'idle',
  soul_error            TEXT,
  soul_refreshed_at     INTEGER,
  soul_refreshing_at    INTEGER,
  soul_manual_edited_at INTEGER,
  soul_next_refresh_at  INTEGER,
  soul_sources          TEXT,
  source                TEXT    NOT NULL DEFAULT 'manual',  -- 'manual' | 'auto_from_contacts'
  original_lang         TEXT,
  source_version        INTEGER NOT NULL DEFAULT 1,
  created_by            TEXT    REFERENCES users(id) ON DELETE SET NULL,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  deleted_at            INTEGER,
  deleted_by            TEXT
);
-- Race-safe dedup for auto-build:
CREATE UNIQUE INDEX idx_businesses_unique_name_ci
  ON businesses(project, lower(name)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_businesses_unique_domain
  ON businesses(project, domain) WHERE domain IS NOT NULL AND deleted_at IS NULL;
```

Plus `business_translations` sidecar — source fields `description`, `notes`, `soul`. `contact_businesses` is the M:N join (see [contacts.md](./contacts.md)).

## HTTP API

- `GET    /api/projects/:p/businesses` — list (`?q=` search, `?limit`/`?offset`).
- `POST   /api/projects/:p/businesses` — create (manual).
- `GET/PATCH/DELETE /api/projects/:p/businesses/:id` — CRUD. DELETE is soft.
- `POST   /api/projects/:p/businesses/edit` — Edit mode (LLM, SSE).
- `POST   /api/projects/:p/businesses/ask` — Ask mode (quick chat).
- `PUT    /api/projects/:p/businesses/:id/soul` — manual soul edit.
- `POST   /api/projects/:p/businesses/:id/soul/refresh` — force soul refresh (SSE).
- `POST   /api/projects/:p/businesses/auto-build` — admin-only manual auto-build trigger (only when project has the flag set or the cfg fallback is on).
- `GET    /api/projects/:p/businesses/:id/contacts` — list linked contacts.

## Code paths

- `src/memory/businesses.ts` — CRUD + soul helpers + race-safe `upsertBusinessByName`. Self-registers `BUSINESS_KIND` (`registerKind`) and the trash entry (`registerTrashable`).
- `src/businesses/soul_refresh_handler.ts` — periodic per-row refresh + the `refreshOneBusinessSoul` helper that the on-demand SSE route reuses.
- `src/businesses/soul_sweep_stuck_handler.ts` — reclaim rows stuck in `soul_status='refreshing'`.
- `src/businesses/auto_build_handler.ts` — opt-in candidate extraction + `INSERT … ON CONFLICT DO NOTHING` upsert + optional one-shot enrichment via `web_search`.
- `src/server/business_routes.ts`.
- `src/tools/lookup_entity.ts` — `lookup_business` closure-bound tool.

## UI

- `web/src/tabs/BusinessesTab.tsx` — card grid + search + admin "Auto-build from contacts" button.
- `web/src/components/BusinessDialog.tsx` — create/edit dialog with socials and a soul preview + "Refresh now" button.
- Sidebar nav under **Content → Businesses** (icon: `Building2`).

## Extension hooks

- **Translation:** yes. Source fields: `description`, `notes`, `soul`. Stale-marking on soul changes is gated by `cfg.businesses.translateSoul`.
- **Trash:** yes via `registerTrashable`. No name-munging (no UNIQUE on `name`); the partial-index UNIQUE on `(project, lower(name)) WHERE deleted_at IS NULL` lets a soft-deleted row coexist with a freshly created one of the same name.
- **Scheduler:** `business.soul_refresh` (default cron `0 */6 * * *`) + `business.soul_sweep_stuck` (every 5 min) + `business.auto_build` (default cron `30 */6 * * *`, opt-in per project).
- **Tools:** `lookup_business` (closure-bound, project-scoped).

## Key invariants

- **Two partial UNIQUE indexes** carry race-safety for auto-build. Removing them lets duplicate `Acme` rows materialise under concurrent ticks.
- **`soul_next_refresh_at` is the cadence anchor.** Manual edits via `PUT .../soul` stamp `soul_manual_edited_at` (kept as audit/seed signal) but don't bump the next-refresh timestamp.
- **The on-demand "Refresh now" route shares one helper with the scheduler** (`refreshOneBusinessSoul`). Don't divergent-fork the per-row work.
- **Auto-build LLM cost is bounded per tick** by `cfg.businesses.autoBuildBatchSize` (default 3). Discovered businesses get a soul-refresh slot via `soul_next_refresh_at = now`; the structured profile fields (`website`, `emails`, `socials`, `address`) come from one optional `web_search`-driven runAgent enrichment call per new row.
- **Address auto-fill rides on soul refresh** — same LLM call, same cadence. `business.soul.refresh` and `business.auto_build.enrich` prompts both ask for an optional `{address: {street, postalCode, city, region, country}}` object alongside the soul body. Empty / unverifiable addresses are dropped by `validateAddress` so an existing manual address never gets blanked. `address_fetched_at` stamps every successful auto-fill so the UI can show "auto-filled <date>".

## Gotchas

- LinkedIn and X actively block public scraping. The soul refresh handles a missing source gracefully (empty `sources`, soul stays at its previous value, status flips to `error` with a clear message). Don't treat repeated `error` rows as a bug — verify the handle is reachable in a regular browser first.
- Auto-build candidate extraction looks at `contacts.company` + email domains + `socials` entries with `platform='website'`. A contact with no `company` and no website-typed social produces no candidate, even if their email domain is unique.
- Trash + Restore work via the standard `registerTrashable` path — translation sidecars are dropped on soft-delete and reseeded on restore.

## Related

- [ADR 0036 — Social handles, per-entity soul, Businesses](../../adr/0036-social-handles-and-businesses.md)
- [ADR 0019 — Contacts](../../adr/0019-contacts.md) — sibling entity
- [ADR 0034 — Per-user / per-agent memory](../../adr/0034-per-user-agent-memory.md) — soul state-machine prior art
- [`./contacts.md`](./contacts.md) — M:N partner entity
- [`../concepts/translation-pipeline.md`](../concepts/translation-pipeline.md)
- [`../concepts/soft-delete-and-trash.md`](../concepts/soft-delete-and-trash.md)
