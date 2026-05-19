# UI patterns

Recurring shapes that show up across tabs. When you're building a new surface, check whether one of these applies first.

## 1. Sidebar-list-plus-detail

Two-column layout: left sidebar with a list + search, right detail pane (empty-state when nothing is selected).

**Users:** Chat (`SessionSidebar`), Documents (`DocumentSidebar`), Whiteboard (`WhiteboardSidebar`), Contacts (groups sidebar), Notifications (`NotificationsTab`).

**Shape:**

```
┌──────────────┬───────────────────────────────┐
│ [+ New]      │                               │
│ [Search…]    │   Detail pane                 │
│ ─────────    │   (or EmptyState when nothing │
│ Item 1       │    is selected)               │
│ Item 2 ◄──── │                               │
│ Item 3       │                               │
└──────────────┴───────────────────────────────┘
```

**Rules:**

- The sidebar is inside the tab, not at the shell level (shell-level columns are the main rail + the tab).
- Selection is persisted to `localStorage` per tab (e.g. `bunny.activeSessionId`).
- Empty-state on the right uses `<EmptyState>` with a rabbit illustration.

## 2. Composer with edit/ask modes

The "talk to an LLM about this entity" pattern. A bottom-docked input with a two-mode toggle: **Edit** (LLM rewrites the entity) / **Ask** (LLM opens a chat about it, returns a session id to navigate into).

**Users:** Documents (`DocumentComposer`), Whiteboard (`WhiteboardComposer`), Contacts, KB definitions.

**Shape:**

```
[ Edit ● ] [ Ask ○ ]
┌─────────────────────────────────────────────┐
│ Prompt…                                    │
│                                    [Send]   │
└─────────────────────────────────────────────┘
```

**Rules:**

- **Edit mode** posts to `/api/<entity>/:id/edit` and streams. The backend uses `runAgent` with `systemPromptOverride` and a hidden session (`session_visibility.hidden_from_chat`). The frontend extracts the new content from the streamed response and updates the local editor optimistically.
- **Ask mode** posts to `/api/<entity>/:id/ask`, gets `{ sessionId }`, navigates to `?tab=chat&session=<id>`.
- Neither mode sets `askUserEnabled` or `mentionsEnabled` — background runs don't ping.

## 3. Modal dialog with tabstrip

Native `<dialog>` element; header with close, body with tabs (Form / Translations / other), footer with Save/Cancel.

**Users:** every entity dialog (see `./component-library.md`).

**Rules:**

- Use the native `<dialog>` — no custom portal.
- Trap focus; ESC closes.
- Save/Cancel live in the footer, never in the body.
- Translations tab uses `<TranslationsPanel>` which drops in wholesale.

## 4. Card grid

A responsive grid of cards — projects, agents, skills, contacts, KB definitions, dashboard KPIs.

**Rules:**

- CSS grid with `minmax(280px, 1fr)` or similar. No fixed columns.
- Card hover: subtle lift via `--shadow-md` + `transform: translateY(-2px)`.
- Delete / edit affordances inside the card; no right-click menus.

## 5. Drag-and-drop

The Board uses `@dnd-kit/core` + `@dnd-kit/sortable` with a `PointerSensor` configured at `distance: 5`. The 5 px threshold means in-card buttons (edit, run, archive) still work — without it, clicking a button triggers a drag.

**Rules:**

- `distance: 5` on the sensor — do not change.
- Optimistic updates: move the card in local state immediately, roll back on a 4xx.
- Sparse positions (steps of 100) so midpoint inserts don't cascade renumber.

## 6. Streaming chat bubble

Per-turn, the bubble starts empty and streams content as SSE frames arrive. Interactive cards (`UserQuestionCard`, `CardRunLog`) compose inside the bubble when the stream carries them.

See `./streaming-ui.md` for the full state machine.

## 7. Optimistic + rollback

- Apply the change to local state immediately.
- Fire the mutation.
- On non-2xx, revert the local change and surface an error toast.

The Board uses this pattern extensively. Any mutation that affects a visible list (cards, contacts, swimlanes) should follow.

## 8. Debounced autosave

Documents, Whiteboards, KB definitions autosave on edit — debounced 2s. Use a `useRef` timer, not a `setInterval` loop.

## 9. Progressive content (thumbnails)

Whiteboards and Documents store a thumbnail data URL alongside the payload. Sidebars render the thumbnail; detail panes load the full content on demand. Thumbnails are generated client-side via `exportToBlob` (Excalidraw) or a canvas render (documents).

## 10. Feature detection

- `Contact Picker API` is only on Android Chrome — feature-detect with `'contacts' in navigator`.
- OS notifications check `window.__TAURI__` first, then `window.Notification`.
- Markdown rendering degrades gracefully if mermaid fails to load.

## Related

- [`./component-library.md`](./component-library.md) — the primitives these patterns compose from.
- [`./streaming-ui.md`](./streaming-ui.md) — pattern 6 in detail.
- [`../entities/`](../entities/) — each entity page shows which patterns it uses.
