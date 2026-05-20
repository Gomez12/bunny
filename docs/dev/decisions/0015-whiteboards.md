# ADR 0015: Per-Project Excalidraw Whiteboards

## Status

Accepted

## Context

Projects need a visual collaboration space for diagrams, architecture sketches, and brainstorming. Users want to maintain a library of named whiteboards per project that agents can also interact with via natural language.

## Decision

Add per-project whiteboards powered by [Excalidraw](https://github.com/excalidraw/excalidraw) with two LLM interaction modes.

### Data model

A single `whiteboards` table stores the Excalidraw elements JSON, optional app-state JSON, and a small PNG thumbnail (data URL). Scoped by `project` with a `UNIQUE(project, name)` constraint. No version history in v1 — the row stores only the current state.

### Two interaction modes

1. **Edit mode** — uses the full agent loop (`runAgent`) for logging, error correction, and retry. The LLM receives the current elements JSON + a PNG screenshot + the user's instruction, and returns modified elements JSON. The session is automatically hidden from Chat/Messages via `session_visibility`. The frontend extracts JSON from the assistant's response, validates it, and updates the Excalidraw canvas.

2. **Question mode** — saves the whiteboard, creates a new chat session with the PNG as an attachment and the user's question as the message, then navigates to the Chat tab. The full chat interface handles the LLM interaction.

### Why agent loop for edit mode

Using `runAgent` instead of a direct `chat()` call gives us: audit logging through the queue, session persistence, potential multi-turn error correction, and consistency with the rest of the system. Edit sessions are hidden from Chat/Messages to keep them separate from regular conversations.

### Thumbnails

Generated client-side via Excalidraw's `exportToBlob` at 200px max dimension. Stored as PNG data URLs in the `thumbnail` column. This avoids server-side rendering dependencies.

### LLM screenshot size

The PNG screenshot attached to edit-mode LLM calls is exported via a dedicated `exportCanvasPngForLlm` helper at **256px** max dimension. Vision tokens scale with pixel area, so the smaller size is roughly 16× cheaper than the 1024px default and still conveys enough spatial/layout context — the Excalidraw elements JSON remains the source of truth. The general-purpose `exportCanvasPng` (1024px) is kept untouched for other uses (downloads, previews).

### System prompt override

`RunAgentOptions` gains an optional `systemPromptOverride` field. When set, it replaces the entire composed system prompt (project + agent + recall). This is used by the whiteboard edit endpoint to give the LLM precise Excalidraw element schema instructions.

## Consequences

- New npm dependency: `@excalidraw/excalidraw` (~2MB chunk, lazy-loaded).
- `systemPromptOverride` on `RunAgentOptions` is a general-purpose escape hatch; future features may use it but it should be used sparingly.
- No collaborative editing — one user at a time. Multi-user sync would require CRDT/OT infrastructure.
- Thumbnail quality is limited by client-side export at low resolution.
