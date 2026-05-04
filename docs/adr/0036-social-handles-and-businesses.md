# ADR 0036 — Social handles, per-entity soul, Businesses

## Status

Accepted, 2026-05-03.

## Context

Contacts shipped with `name`, `emails[]`, `phones[]`, `company`, `title`, `notes`, `tags[]`, `avatar`, and groups. Soul-style periodic curation existed only for users (`users.soul*` plus `user_project_memory`, `agent_project_memory` — see ADR 0034). Two limits showed up in practice:

1. **Contacts couldn't carry social handles**, so the agent could not surface what a person is currently doing — only what the operator typed in `notes`.
2. **There was no first-class organisation entity.** "Acme Inc." lived as a free-text `company` string repeated across every Acme contact, with no shared profile, no shared notes, no derived insight.

We want both: social handles on contacts plus a periodically refreshed per-contact "soul", and a sibling `Businesses` entity with the same soul mechanism, M:N linked to contacts, optionally auto-built from the contacts' company + email/website domains.

## Decision

### Three additions, one mechanism

**1. Social handles on contacts.** New `contacts.socials TEXT NOT NULL DEFAULT '[]'` column, JSON array of `{platform, handle, url?}`. Platform whitelist matches what the vCard import can produce (`twitter`, `x`, `linkedin`, `github`, `mastodon`, `instagram`, `youtube`, `tiktok`, `bluesky`, `facebook`, `website`, `other`). vCard parser learns `URL` and `X-SOCIALPROFILE` (Apple iCloud), plus `IMPP` and the legacy `X-TWITTER` / `X-LINKEDIN` / `X-GITHUB` family.

**2. Per-entity soul.** Both `contacts` and `businesses` carry the eight `soul_*` columns (`soul`, `soul_status`, `soul_error`, `soul_refreshed_at`, `soul_refreshing_at`, `soul_manual_edited_at`, `soul_next_refresh_at`, `soul_sources`). State machine `idle → refreshing → (idle | error)` mirrors `user_project_memory`. The refresh handler runs every 6 h (`cfg.contacts.soulRefreshCron`, `cfg.businesses.soulRefreshCron`), driving `runAgent` with `webCfg` spliced in and a project-overridable system prompt that demands a fenced `\`\`\`json{soul, sources}\`\`\`` block. Parsing reuses the KB pattern (`extractSoulJson` mirrors `extractDefinitionJson`). Hard cap 4000 chars via `ENTITY_SOUL_CHAR_LIMIT` (deliberately separate from `MEMORY_FIELD_CHAR_LIMIT` so future tuning of the user-memory cap doesn't drag entity-soul along).

**3. Businesses.** New `businesses` table with `name`, `domain`, `description`, `notes`, `website`, `emails[]`, `phones[]`, `socials[]`, `logo`, `tags[]`, the soul fields, plus `source ∈ {manual, auto_from_contacts}` and translation/soft-delete columns matching contacts. M:N link via `contact_businesses(contact_id, business_id, role?, is_primary)`.

Auto-build is opt-in per project via `projects.auto_build_businesses INTEGER NOT NULL DEFAULT 0` (admin-toggleable PATCH on `/api/projects/:name`). The `business.auto_build` handler walks alive contacts in opt-in projects, extracts `(name, domain)` candidates from `company` + email/website domains, and inserts new businesses via `INSERT … ON CONFLICT DO NOTHING RETURNING id` against two partial UNIQUE indexes — `(project, lower(name)) WHERE deleted_at IS NULL` and `(project, domain) WHERE domain IS NOT NULL AND deleted_at IS NULL`. The conflict path reads the existing row's id and links the contact anyway, so concurrent ticks converge on one business per `(project, name)` pair without duplicate rows.

### Translation parity

Contact `notes` was already translated; now `soul` joins it (sidecar `contact_translations` gains a nullable `soul TEXT`). Business `description` + `notes` + `soul` are all translated via the new `business_translations` sidecar. Stale-marking on every soul change is **gated by a per-domain config knob** (`cfg.contacts.translateSoul`, `cfg.businesses.translateSoul`, both default true) so a project with five languages × a hundred contacts × a 6-hour cadence can opt out without sacrificing notes translation.

### Soul visibility

Souls are surfaced in the entity dialog UI plus on-demand via two new closure-bound agent tools: `lookup_contact` and `lookup_business`. Both are project-scoped through their closure (cross-project leakage impossible) and added to `DYNAMIC_TOOL_NAMES` so they splice into every project-scoped run. There is **no automatic soul injection in the system prompt** — the cost of carrying every contact's soul on every turn outweighs the value, and the lookup tool gives the agent precise control over when to consult one.

## Consequences

**Schema is append-only.** Every change is a new column or new table. The two partial UNIQUE indexes on `businesses` are deliberately partial so a soft-deleted `Acme` row coexists with a freshly recreated one.

**The on-demand "Refresh now" route shares one helper with the scheduler.** `refreshOneContactSoul` / `refreshOneBusinessSoul` are exported from the handler module so the SSE route streams via the same race-safe claim → runAgent → parse → store path as the periodic tick. Result: only one place to fix when the contract drifts.

**Auto-build is bounded.** Each tick caps total LLM calls at `cfg.businesses.autoBuildBatchSize` (default 3). Discovered businesses get `soul_next_refresh_at = now` so the soul handler picks them up on its next pass; the auto-build itself only writes structured profile fields.

**Trade-off the user accepted.** Translating soul keeps full parity with notes but multiplies translation cost. The `translate_soul` knobs let an operator opt out of soul translation per domain without losing notes translation.

## Out of scope (v1)

- **Business groups** — `tags` covers v1 needs; defer until concrete demand.
- **Affiliations picker UI inside ContactDialog** — the M:N link helpers and HTTP routes are wired (`POST /contacts/:id/businesses` / `DELETE …/:businessId`), but the dialog has no autocomplete to add/remove businesses today; affiliations are managed via the API or the future v1.1 picker.
- **Edit / Ask LLM modes for businesses surfaced in BusinessesTab** — the routes exist (`/businesses/edit`, `/businesses/ask`) but the tab doesn't expose a composer; v1.1 will mirror the contacts pattern.
- **Dedicated `business.edit` prompt key** — the edit route reuses `contact.edit`; a project-overridable `business.edit` entry lands when the UI does.
- **Logo auto-discovery** (Clearbit, favicon API) — manual upload only.
- **OAuth-protected platform APIs** (X, LinkedIn) — public scraping via `web_fetch`/`web_search` only. Blocked platforms produce empty `sources`; the soul stays on its previous value with `status='error'` and a clear message.
- **SVG illustrations for businesses** — KB-style illustration is out; a manual logo upload is the current affordance.
- **Push notifications on soul refresh** — silent background. SSE only when the user clicks "Refresh now".

## References

- ADR 0019 — Contacts (the entity this builds on)
- ADR 0021 — Knowledge Base definitions (race-safe `setLlmGenerating` pattern)
- ADR 0022 — Multi-language translation (sidecar shape)
- ADR 0024 — Web News (race-safe `claimTopicForRun`, runAgent + webCfg pattern)
- ADR 0025 — Soft-delete + trash
- ADR 0034 — Per-user / per-agent memory (soul state machine prior art)
- `src/contacts/soul_refresh_handler.ts`, `src/businesses/soul_refresh_handler.ts`, `src/businesses/auto_build_handler.ts`, `src/tools/lookup_entity.ts`, `src/server/business_routes.ts`
