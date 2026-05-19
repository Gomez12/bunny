# Contacts

## What it is

Per-project contact management with groups. Emails, phones, tags, and **social handles** are JSON arrays to avoid join tables for simple lists. Supports vCard import/export, Contact Picker API on Android, and the usual Edit/Ask LLM modes. Each contact carries a periodically refreshed **soul** body (LLM-curated summary of what the person is currently up to, scraped from their public socials + website) — see [ADR 0036](../../adr/0036-social-handles-and-businesses.md).

## Data model

```sql
CREATE TABLE contacts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  project        TEXT    NOT NULL,
  name           TEXT    NOT NULL,
  emails         TEXT    NOT NULL DEFAULT '[]',     -- JSON array
  phones         TEXT    NOT NULL DEFAULT '[]',     -- JSON array
  company        TEXT    NOT NULL DEFAULT '',
  title          TEXT    NOT NULL DEFAULT '',
  notes          TEXT    NOT NULL DEFAULT '',
  avatar         TEXT,                              -- data URL
  tags           TEXT    NOT NULL DEFAULT '[]',     -- JSON array
  original_lang  TEXT,
  source_version INTEGER NOT NULL DEFAULT 1,
  created_by     TEXT    REFERENCES users(id) ON DELETE SET NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  deleted_at     INTEGER,
  deleted_by     TEXT
);

CREATE TABLE contact_groups (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project     TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  color       TEXT,
  created_by  TEXT    REFERENCES users(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE(project, name)
);

CREATE TABLE contact_group_members (
  group_id    INTEGER NOT NULL REFERENCES contact_groups(id) ON DELETE CASCADE,
  contact_id  INTEGER NOT NULL REFERENCES contacts(id)       ON DELETE CASCADE,
  PRIMARY KEY (group_id, contact_id)
);
```

**Soul + social columns (ADR 0036):**

```sql
ALTER TABLE contacts ADD COLUMN socials               TEXT NOT NULL DEFAULT '[]';  -- JSON: [{platform, handle, url?}]
ALTER TABLE contacts ADD COLUMN soul                  TEXT NOT NULL DEFAULT '';
ALTER TABLE contacts ADD COLUMN soul_status           TEXT NOT NULL DEFAULT 'idle';
ALTER TABLE contacts ADD COLUMN soul_error            TEXT;
ALTER TABLE contacts ADD COLUMN soul_refreshed_at     INTEGER;
ALTER TABLE contacts ADD COLUMN soul_refreshing_at    INTEGER;
ALTER TABLE contacts ADD COLUMN soul_manual_edited_at INTEGER;
ALTER TABLE contacts ADD COLUMN soul_next_refresh_at  INTEGER;
ALTER TABLE contacts ADD COLUMN soul_sources          TEXT;  -- JSON: [{url, fetchedAt}]
```

Plus `contact_translations` sidecar — source fields are `notes` and `soul` (other structured fields stay untranslated).

**M:N to businesses (ADR 0036):**

```sql
CREATE TABLE contact_businesses (
  contact_id   INTEGER NOT NULL REFERENCES contacts(id)   ON DELETE CASCADE,
  business_id  INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  role         TEXT,
  is_primary   INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (contact_id, business_id)
);
```

## HTTP API

- `GET /api/projects/:p/contacts` — list (filtered to `deleted_at IS NULL`).
- `POST /api/projects/:p/contacts` — create.
- `GET/PATCH/DELETE /api/projects/:p/contacts/:id` — CRUD. DELETE is soft.
- `POST /api/projects/:p/contacts/import` — vCard bulk import.
- `GET /api/projects/:p/contacts/:id/vcf` — single-contact vCard export.
- `POST /api/projects/:p/contacts/export` — bulk vCard export.
- `GET/POST /api/projects/:p/contact-groups` — list + create.
- `PATCH/DELETE /api/projects/:p/contact-groups/:id`.
- `POST /api/projects/:p/contacts/edit` — Edit mode (analyse / organise contacts).
- `POST /api/projects/:p/contacts/ask` — Ask mode.
- `PUT  /api/projects/:p/contacts/:id/soul` — manual soul edit (≤ 4000 chars).
- `POST /api/projects/:p/contacts/:id/soul/refresh` — force soul refresh now (SSE).
- `POST /api/projects/:p/contacts/:id/businesses` — link to a business `{businessId, role?, isPrimary?}`.
- `DELETE /api/projects/:p/contacts/:id/businesses/:businessId` — unlink.

## Code paths

- `src/memory/contacts.ts` — CRUD + groups + bulk import + vCard export. Calls `registerTrashable`, `registerKind`.
- `src/server/contact_routes.ts`.
- `web/src/lib/vcard.ts` — client-side vCard parser (no deps, handles vCard 2.1/3.0/4.0 basics).

## UI

- `web/src/tabs/ContactsTab.tsx` — sidebar (groups) + main card grid + search.
- `web/src/components/ContactDialog.tsx` — create/edit.
- `web/src/components/ContactImportDialog.tsx` — drag-and-drop zone + preview table.
- Contact Picker API button on Android Chrome (feature-detected via `'contacts' in navigator`).

## Extension hooks

- **Translation:** yes. Source fields: `notes`, `soul`. `contact_translations` sidecar. Soul stale-marking is gated by `cfg.contacts.translateSoul`.
- **Trash:** yes. Soft-delete — contacts don't have a UNIQUE(project, name) constraint (names can repeat), so no name-munging required.
- **Notifications:** no.
- **Scheduler:** `contact.soul_refresh` (default cron `0 */6 * * *`) + `contact.soul_sweep_stuck` (every 5 min).
- **Tools:** `lookup_contact` (closure-bound, project-scoped) returns name/emails/phones/socials/soul + linked businesses.

## vCard import/export

- **Import** is client-side — `web/src/lib/vcard.ts` parses the file, the import dialog previews the rows, the user confirms, then the dialog POSTs to `/api/projects/:p/contacts/import`.
- **Export** is server-side — vCard 3.0. Supports single contact (`GET .../:id/vcf`) or bulk (`POST .../export` with an array of ids or a group filter).

## Edit mode

Analyses contacts via a prompt. Same pattern as documents — hidden session, `systemPromptOverride`, SSE.

## Key invariants

- **Emails, phones, tags are JSON arrays.** No join tables.
- **Avatar is a data URL on the row.** Large avatars bloat the list payload — keep them small (~100 KB).
- **Contacts don't have unique names.** Soft-delete doesn't need name-munging.
- **Groups are project-scoped.** `UNIQUE(project, name)` on `contact_groups`.

## Gotchas

- The vCard parser covers 2.1 / 3.0 / 4.0 basics (N, FN, EMAIL, TEL, ORG, TITLE, NOTE, PHOTO base64). Rare fields (TZ, GEO, X-*) are dropped silently.
- Contact Picker API exists only on Android Chrome. Feature-detect before showing the button; otherwise the button does nothing on desktop.
- Avatars encoded as data URLs can exceed SQLite's comfortable column size for list payloads — consider moving to workspace-file references if the UX starts lagging.
- Bulk export for a project with many contacts can produce a multi-MB .vcf — the endpoint streams rather than buffers.

## Related

- [ADR 0019 — Contacts](../../adr/0019-contacts.md)
- [`../concepts/translation-pipeline.md`](../concepts/translation-pipeline.md)
- [`../concepts/soft-delete-and-trash.md`](../concepts/soft-delete-and-trash.md)
