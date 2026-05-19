# Whiteboards

## What it is

Per-project Excalidraw whiteboards for visual collaboration. Each project can have multiple named whiteboards. Two LLM interaction modes (Edit / Ask) — same pattern as documents, contacts, KB definitions.

## Data model

```sql
CREATE TABLE whiteboards (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project         TEXT    NOT NULL,
  name            TEXT    NOT NULL,
  elements_json   TEXT    NOT NULL DEFAULT '[]',
  app_state_json  TEXT,
  thumbnail       TEXT,                          -- PNG data URL (~200×150)
  created_by      TEXT    REFERENCES users(id) ON DELETE SET NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  deleted_at      INTEGER,
  deleted_by      TEXT,
  UNIQUE(project, name)
);
```

No sidecar translation table — whiteboards aren't translated.

## HTTP API

- `GET /api/projects/:p/whiteboards` — list.
- `POST /api/projects/:p/whiteboards` — create.
- `GET/PATCH/DELETE /api/whiteboards/:id`. DELETE is soft (Trash).
- `POST /api/whiteboards/:id/edit` — Edit mode. SSE.
- `POST /api/whiteboards/:id/ask` — Ask mode. Returns `{ sessionId }`.

## Code paths

- `src/memory/whiteboards.ts` — CRUD + `canEditWhiteboard` + `registerTrashable`.
- `src/server/whiteboard_routes.ts`.
- `src/agent/loop.ts:runAgent` — invoked with `systemPromptOverride` for Edit mode.

## UI

- `web/src/tabs/WhiteboardTab.tsx` — sidebar + canvas + composer.
- `web/src/components/WhiteboardSidebar.tsx` — list with thumbnails.
- `web/src/components/WhiteboardCanvas.tsx` — Excalidraw mount + fullscreen toggle.
- `web/src/components/WhiteboardComposer.tsx` — Edit/Ask mode toggle + prompt box.

Frontend dep: `@excalidraw/excalidraw`.

## Extension hooks

- **Translation:** no.
- **Trash:** yes. Soft-delete renames to `__trash:<id>:<name>`.
- **Notifications:** no.
- **Scheduler:** no.
- **Tools:** no.

## Edit mode

```
POST /api/whiteboards/:id/edit { prompt }
  → hidden session
  → runAgent({
      systemPromptOverride: "You are a whiteboard editor. Respond with a JSON array of Excalidraw elements only.",
      askUserEnabled: false,
      mentionsEnabled: false,
      ...
    })
  → streamed SSE
  → frontend extracts JSON from the response, updates the canvas
```

The JSON format is the Excalidraw elements array — same shape the canvas reads on load.

## Ask mode

Posts to `/api/whiteboards/:id/ask` with the whiteboard's PNG attached. The server creates a chat session with the PNG as an attachment, returns `{ sessionId }`, and the frontend navigates to `?tab=chat&session=<id>`.

## Thumbnails

Generated client-side via `exportToBlob` (Excalidraw helper). Stored as a PNG data URL on the row. The sidebar shows the thumbnail; the canvas loads full `elements_json` on demand.

## Auto-save

Debounced 2s — a `useRef` timer, not `setInterval`. Edit mode operations do not debounce; they commit immediately.

## Key invariants

- **`elements_json` is the canonical format.** Thumbnail is a derived view.
- **Thumbnails regenerate on material change.** `exportToBlob` is cheap.
- **Excalidraw's `app_state` is opaque.** Don't parse it — round-trip as-is.
- **One Excalidraw instance per WhiteboardCanvas.** Unmount cleanly on tab switch.

## Gotchas

- Excalidraw renders to canvas — fullscreen is handled by a CSS class, not a canvas re-init.
- Soft-delete renames the row; every list/get query filters `deleted_at IS NULL`. Documents embedding a soft-deleted whiteboard render an error placeholder.
- The Edit mode prompt must produce parseable JSON. If the model wraps it in a ```json``` fence, the frontend strips the fence before loading.
- Whiteboards aren't project-scoped for collaborative editing — simultaneous edits in two browsers will race. Last-write-wins.

## Related

- [ADR 0015 — Whiteboards](../../adr/0015-whiteboards.md)
- [`./documents.md`](./documents.md) — embeds whiteboards.
- [`../ui/tiptap-extensions.md`](../ui/tiptap-extensions.md) — `WhiteboardEmbedNode`.
- [`../concepts/soft-delete-and-trash.md`](../concepts/soft-delete-and-trash.md)
