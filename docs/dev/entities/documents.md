# Documents

## What it is

Per-project rich-text documents. Markdown is canonical on disk; the WYSIWYG editor (Tiptap) is the ephemeral presentation layer. Two LLM interaction modes (Edit / Ask) follow the same pattern as whiteboards, contacts, and KB definitions.

## Data model

```sql
CREATE TABLE documents (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project         TEXT    NOT NULL,
  name            TEXT    NOT NULL,
  content_md      TEXT    NOT NULL DEFAULT '',
  thumbnail       TEXT,
  is_template     INTEGER NOT NULL DEFAULT 0,
  original_lang   TEXT,
  source_version  INTEGER NOT NULL DEFAULT 1,
  created_by      TEXT    REFERENCES users(id) ON DELETE SET NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  deleted_at      INTEGER,
  deleted_by      TEXT,
  UNIQUE(project, name)
);
```

Plus `document_translations` sidecar (see `concepts/translation-pipeline.md`).

## HTTP API

- `GET /api/projects/:p/documents` — list (excludes trashed).
- `POST /api/projects/:p/documents` — create.
- `GET/PATCH/DELETE /api/documents/:id` — CRUD. DELETE is soft — row moves to Trash.
- `POST /api/documents/:id/edit` — Edit mode. SSE.
- `POST /api/documents/:id/ask` — Ask mode. Returns `{ sessionId }`.
- `POST /api/documents/:id/images` — multipart upload.
- `POST /api/documents/:id/export/docx` — Word export (server-side, `docx` npm package).
- `POST /api/documents/:id/export/html` — zip of HTML + images (`jszip`).
- `POST /api/documents/:id/save-as-template` — flip `is_template = 1` copy.

## Code paths

- `src/memory/documents.ts` — CRUD + `canEditDocument`. Calls `registerTrashable`, `registerKind`, `createTranslationSlots`, `markAllStale`.
- `src/memory/workspace_fs.ts` — image storage at `<projectDir>/workspace/documents/<docId>/images/<uuid>.<ext>`.
- `src/server/document_routes.ts` — HTTP surface.
- `src/agent/loop.ts:runAgent` — invoked with `systemPromptOverride` for Edit mode.

## UI

- `web/src/tabs/DocumentTab.tsx` — sidebar-list-plus-detail pattern.
- `web/src/components/DocumentSidebar.tsx` — list + search + new-doc.
- `web/src/components/DocumentEditor.tsx` — Tiptap mount, extensions, autosave.
- `web/src/components/DocumentRibbon.tsx` — Word-style toolbar (headings, lists, alignment, tables, images, whiteboard embed, export).
- `web/src/components/DocumentComposer.tsx` — Edit/Ask mode toggle + prompt box.
- `web/src/components/tiptap/WhiteboardEmbedNode.tsx` — custom node for whiteboard embeds.
- `web/src/components/WhiteboardPickerDialog.tsx` — picker for the embed.

Frontend deps: `@tiptap/react`, `@tiptap/starter-kit`, various `@tiptap/extension-*`, `tiptap-markdown`.

## Extension hooks

- **Translation:** yes. Source fields: `name`, `content_md`. `document_translations` sidecar.
- **Trash:** yes. Soft-delete renames to `__trash:<id>:<name>` so `UNIQUE(project, name)` doesn't collide. Restore reseeds translations.
- **Notifications:** no.
- **Scheduler:** no.
- **Tools:** no direct agent tool (edit mode is a human-triggered operation).

## Edit mode

```
POST /api/documents/:id/edit { prompt }
  → hidden session (session_visibility.hidden_from_chat = 1)
  → runAgent({
      project,
      systemPromptOverride: "You are a document editor. Respond with the new markdown only.",
      askUserEnabled: false,
      mentionsEnabled: false,
      ...
    })
  → streamed SSE
  → frontend extracts markdown from the response, updates the editor
```

## Ask mode

```
POST /api/documents/:id/ask { prompt }
  → create chat session with document content + prompt prefilled
  → return { sessionId }
  → frontend navigates to ?tab=chat&session=<id>
```

## Images

Drag or paste into the editor:

```
→ POST /api/documents/:id/images (multipart)
  → workspace_fs.writeWorkspaceFile('documents/<docId>/images/<uuid>.<ext>')
  → return { path }
  → editor inserts <img src="/api/projects/:p/workspace/file?path=...&encoding=raw">
```

Images are selectable with an accent outline. Not copied on fork — the file stays in place.

## Whiteboard embeds

Two modes:

- **Live** — re-fetches latest thumbnail on render.
- **Static** — snapshot data URL at insert time.

Markdown representation uses a fenced block with JSON metadata so round-trip is idempotent. See `../ui/tiptap-extensions.md`.

## Exports

- **DOCX** — `docx` npm package, server-side. Produces a real Word file.
- **HTML zip** — `jszip`, bundles the document + inline images.
- **PDF** — client-side `window.print()` with a print stylesheet (`@media print`).

## Key invariants

- **Markdown is canonical.** Tiptap is presentation. Round-trip must be idempotent.
- **Autosave debounced 2s.**
- **Thumbnail regenerated on material change.** Client-side canvas render, stored as data URL.
- **Name is immutable-ish.** Updating it via PATCH is allowed but collisions return 409.

## Gotchas

- Pasting from Word / Notion often carries classes + styles `tiptap-markdown` can't round-trip cleanly. The starter-kit sanitises most; tables + nested lists are the common edge cases.
- Soft-delete renames the row to `__trash:<id>:<name>`. List queries filter `deleted_at IS NULL` — skip that filter and the mangled name leaks.
- Embedded whiteboards that got soft-deleted render an error placeholder. Restore the whiteboard to fix.
- DOCX export doesn't preserve custom nodes (whiteboard embeds); they're rasterised into the exported stream as thumbnails.

## Related

- [ADR 0016 — Documents](../../adr/0016-documents.md)
- [`./whiteboards.md`](./whiteboards.md)
- [`../ui/tiptap-extensions.md`](../ui/tiptap-extensions.md)
- [`../concepts/translation-pipeline.md`](../concepts/translation-pipeline.md)
- [`../concepts/soft-delete-and-trash.md`](../concepts/soft-delete-and-trash.md)
