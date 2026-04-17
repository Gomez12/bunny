# ADR 0016: Per-Project Rich-Text Documents

## Status

Accepted

## Context

Projects need long-form written content — specifications, meeting notes, reports — that goes beyond what chat messages or freeform whiteboards offer. Users want a Word-like editing experience with the full formatting palette, while keeping the underlying format portable (markdown). The document should also be accessible to the LLM for editing and Q&A.

## Decision

Add per-project rich-text documents powered by [Tiptap](https://tiptap.dev) (ProseMirror-based) with markdown as the storage format and two LLM interaction modes (same pattern as whiteboards).

### Data model

A single `documents` table stores the markdown content and an optional thumbnail. Scoped by `project` with a `UNIQUE(project, name)` constraint. No version history in v1 — the row stores only the current state.

```sql
CREATE TABLE IF NOT EXISTS documents (
  id, project, name, content_md, thumbnail, created_by, created_at, updated_at
);
```

### Editor stack

- **Tiptap** with StarterKit, Table, Image, Underline, TextAlign, Highlight, Color, TextStyle, Placeholder, TaskList, TaskItem extensions.
- **tiptap-markdown** for bidirectional serialization between ProseMirror state and markdown.
- **Word-style ribbon** toolbar (`DocumentRibbon.tsx`) with grouped formatting controls.
- **WYSIWYG/Code toggle** — subtle mode switch in the ribbon to edit raw markdown directly.

### Why Tiptap

Fully customizable toolbar (supports the ribbon layout), native markdown round-trip via `tiptap-markdown`, extensible with custom nodes (for future whiteboard embeds, mermaid blocks), active maintenance, and React 19 compatible. Alternatives considered: BlockNote (too opinionated on block structure, harder to customize toolbar), Milkdown (less mature ecosystem).

### Two interaction modes

Same pattern as whiteboards (ADR 0015):

1. **Edit mode** — `POST /api/documents/:id/edit` uses `runAgent` with `systemPromptOverride`. The LLM receives the current markdown + instruction, returns updated markdown in a code fence. Frontend extracts the markdown and updates the editor.

2. **Question mode** — `POST /api/documents/:id/ask` creates a chat session with the document content + question, returns `{ sessionId }` for navigation to Chat tab.

### Autosave

Same debounced pattern as whiteboards — saves to backend after configurable delay (default 5s from UI config). Manual save button in the composer.

## Consequences

- New npm dependencies: `@tiptap/react`, `@tiptap/starter-kit`, various `@tiptap/extension-*`, `tiptap-markdown` (~200KB total chunk, lazy-loaded via tab).
- Markdown round-trip fidelity is the key risk. Tables, task lists, and code blocks with language tags must survive. If `tiptap-markdown` drops information, a `content_json` column can be added to store ProseMirror JSON as a parallel source of truth.
- No collaborative editing — one user at a time, same as whiteboards.
- All planned future phases are now implemented: image drag-and-drop with workspace storage (`POST /api/documents/:id/images`), whiteboard embeds with live and static modes (`WhiteboardEmbedNode.tsx`), and export to Word (.docx), HTML (zip), and PDF (print stylesheet). See the Documents section of `CLAUDE.md` for full details.
