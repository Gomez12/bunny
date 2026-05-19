# ADR 0019 — Per-Project Contact Management

**Status:** Accepted  
**Date:** 2026-04-17

## Context

Users need a way to manage contact persons within each project. Contacts are a natural addition to the per-project workspace model (boards, whiteboards, documents, files). The system should support importing contacts from phones (iPhone and Android) and provide LLM-powered analysis and querying of contacts.

## Decision

### Data model

Three tables added to `src/memory/schema.sql`:

- **`contacts`** — per-project contact records with JSON array columns for `emails`, `phones`, and `tags` (avoids join tables for simple lists). Avatar stored as data URL (same pattern as whiteboard thumbnails).
- **`contact_groups`** — per-project groups with optional color. `UNIQUE(project, name)`.
- **`contact_group_members`** — many-to-many join table with cascade deletes.

### UI layout

The Contacts tab uses a sidebar + main area layout (same grid as Whiteboard/Document tabs):

- **Sidebar (260px):** "All Contacts" entry + group list with color dots, member counts, and inline rename/delete. Click to filter the card grid.
- **Main area:** search bar (debounced 300ms), toolbar (New Contact / Import / Export), card grid with luxurious contact cards (avatar circles with gradient + initials, hover lift animation).
- **Composer at bottom:** edit/question mode toggle, same pattern as Document/Whiteboard tabs. Edit mode streams an agent response; question mode creates a chat session and navigates to the Chat tab.

### Import/export

- **vCard (.vcf) import:** client-side parser in `web/src/lib/vcard.ts` (no external deps). Handles vCard 2.1/3.0/4.0 basics (FN, N, EMAIL, TEL, ORG, TITLE, NOTE, PHOTO). Import dialog with drag-and-drop zone and preview table.
- **Contact Picker API:** enhancement for Android Chrome users (`navigator.contacts`). Feature-detected; hidden on unsupported platforms.
- **vCard export:** server-side generation in `src/memory/contacts.ts`. Single contact or bulk export.

### LLM integration

Two endpoints follow the established Document/Whiteboard pattern:

- `POST /api/projects/:p/contacts/edit` — runs `runAgent` with `systemPromptOverride`, streams SSE. Session hidden from chat.
- `POST /api/projects/:p/contacts/ask` — creates a visible chat session with contacts context pre-loaded, returns `{ sessionId }`.

## Consequences

- Adds 3 tables to the schema. Follows the append-only convention.
- Reuses existing sidebar, composer, and modal CSS patterns. Contact-specific styles use `.contacts-*` and `.contact-card-*` class prefixes.
- The bulk import uses a transaction so partial failures roll back cleanly.
- No project-linking pattern needed (unlike agents/skills) — contacts belong directly to a project.
