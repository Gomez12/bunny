# Tiptap extensions

## At a glance

Documents use **Tiptap** (a ProseMirror-based WYSIWYG) with `tiptap-markdown` for round-trip markdown serialisation. The ribbon toolbar (`DocumentRibbon.tsx`) is Word-styled. Custom nodes handle whiteboard embeds, images, and anything else that isn't native markdown.

## Where it lives

- `web/src/components/DocumentEditor.tsx` — editor bootstrap + extensions list + schema wiring.
- `web/src/components/DocumentRibbon.tsx` — toolbar.
- `web/src/components/tiptap/WhiteboardEmbedNode.tsx` — custom node for whiteboard embeds.
- `web/src/tabs/DocumentTab.tsx` — tab shell, sidebar list, autosave wiring.

## Frontend dependencies

- `@tiptap/react` — React bindings.
- `@tiptap/starter-kit` — paragraph, heading, bold, italic, etc.
- `@tiptap/extension-*` — a handful of specific extensions (image, table, link).
- `tiptap-markdown` — markdown round-trip serialiser.

## The serialisation boundary

The canonical content format is **markdown** (`documents.content_md`). The WYSIWYG is the ephemeral presentation layer. On load, `tiptap-markdown` parses MD → Tiptap nodes; on save, nodes → MD.

This means:

- Any custom node must round-trip through markdown. Use a fenced syntax (e.g. custom HTML comments, fenced blocks with a unique lang tag).
- The markdown "Code mode" toggle in the ribbon shows the raw source — it must be editable and re-parseable.

## Custom nodes

### `WhiteboardEmbedNode`

Lives in `web/src/components/tiptap/WhiteboardEmbedNode.tsx`. Embeds a whiteboard from the current project.

Two modes:

- **Live** — re-fetches the latest thumbnail on render.
- **Static** — snapshot data URL captured at insert time.

Markdown representation: a fenced block with attribute metadata so the parse round-trips:

```markdown
```whiteboard
{"id": 42, "mode": "live"}
```
```

Inserted via `WhiteboardPickerDialog.tsx` (picker + mode radio).

### Adding a new custom node

See [`../how-to/add-a-tiptap-node.md`](../how-to/add-a-tiptap-node.md) for the step-by-step. Summary:

1. Write a React component for the node view.
2. Define a Tiptap `Node` extension with `parseHTML` + `renderHTML` (or a custom markdown serializer).
3. Add the extension to `DocumentEditor.tsx`'s extension list.
4. Add a ribbon button in `DocumentRibbon.tsx`.
5. Test round-trip: MD → editor → MD must be idempotent.

## Images

Images drag-drop or paste into the editor. Upload flow:

```
paste / drop → POST /api/documents/:id/images (multipart)
              → server writes to <projectDir>/workspace/documents/<docId>/images/<uuid>.<ext>
              → server returns { path }
              → editor inserts <img src="/api/projects/:p/workspace/file?path=...&encoding=raw">
```

Selected images have an accent outline via the ribbon's select-image affordance. Images are not copied on fork — the file stays where it is.

## Exports

Document exports live on the server, invoked by ribbon buttons:

- **Word (`.docx`)** — `POST /api/documents/:id/export/docx`. Uses the `docx` npm package server-side.
- **HTML zip** — `POST /api/documents/:id/export/html`. Uses `jszip`. Bundles images.
- **PDF** — client-side `window.print()` with a print stylesheet. Cheap, relies on the browser.

## Rules

- **Markdown is canonical.** Custom nodes must round-trip.
- **Thumbnail on save.** Regenerate (canvas render) when content changes materially. Stored as a data URL on the row.
- **Autosave debounced 2s.** `useRef` timer, not `setInterval`.
- **Ribbon buttons feature-gate by editor state.** Disabled when no selection / no active range.

## Gotchas

- `tiptap-markdown` is opinionated about paragraph breaks. Edge cases (lists inside lists, custom nodes adjacent to code blocks) can produce non-idempotent round-trips — test with your real content.
- Pasting rich HTML (from Word / Notion) often carries spans and styles you don't want. The `starter-kit` sanitises most of it; surprises happen with tables.
- The `window.print()` PDF export inherits the page's stylesheet. Keep a `@media print` block in `styles.css` that strips chrome.
- Whiteboard embeds break if the referenced whiteboard is soft-deleted — the node renders an error placeholder. Restore the whiteboard to fix.

## Related

- [`../entities/documents.md`](../entities/documents.md) — the tab.
- [`../entities/whiteboards.md`](../entities/whiteboards.md) — the embed target.
- [`../how-to/add-a-tiptap-node.md`](../how-to/add-a-tiptap-node.md) — recipe.
- [ADR 0016 — Documents](../../adr/0016-documents.md)
