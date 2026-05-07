# ADR 0040 — Diagrams Subsystem

**Status:** Accepted  
**Date:** 2026-05-07

## Context

Users needed a Visio-like per-project diagram editor with LLM-assisted creation and editing. The existing whiteboard subsystem (Excalidraw) covers free-form drawing but lacks the structured node-and-edge model required for network diagrams, org charts, architecture diagrams, and similar typed content. The project already ships `@xyflow/react` and `dagre` for the code graph and workflows subsystems, so no new runtime dependencies were required.

## Decision

### Data model

Two new tables:

- **`diagrams`** — per-project entity with `diagram_type`, `content_json` (`{ nodes, edges }` in xyflow format), `thumbnail`, and standard soft-delete columns. Mirrors `whiteboards` in structure.
- **`diagram_node_library`** — global seeded nodes (`project IS NULL, is_seeded = 1`) plus per-project custom additions (`project = X, is_seeded = 0`). List queries combine both with `WHERE is_seeded = 1 OR project = ?`.

### Node library seeding

`src/diagrams/seed_library.ts` exports 80+ nodes across ten diagram types (network, flowchart, orgchart, architecture, er, sequence, mindmap, class, bpmn, custom). `ensureSeededLibrary` runs at boot and is idempotent — it skips insertion if any seeded row already exists.

### LLM integration (three prompts)

| Key | Trigger | Output contract |
|-----|---------|-----------------|
| `diagram.generate` | New diagram with non-empty intent | `{ nodes, edges }` JSON block |
| `diagram.edit` | Composer Edit mode | Updated `{ nodes, edges }` JSON block |
| `diagram.node.generate` | "Add via AI" in library panel | Single library item JSON |

All three use `systemPromptOverride` via `resolvePrompt`, run in hidden sessions (`setSessionHiddenFromChat`), and are `projectOverridable`. The "ask" mode reuses the standard quick-chat pattern (no hidden session, opened in Chat tab).

### Frontend layout

```
┌─────────────────────────────────────────────────────┐
│ Toolbar: ← name [type] [save status] actions        │
├──────────────┬──────────────────────────────────────┤
│ Node Library │     xyflow Canvas                    │
│ (220 px)     │                                      │
│              ├──────────────────────────────────────┤
│              │ EntityComposer (Edit | Question)     │
└──────────────┴──────────────────────────────────────┘
```

- Single custom xyflow node type `diagramNode` rendered by `DiagramNode.tsx`.
- Shapes handled via CSS: border-radius (ellipse), clip-path (hexagon), transform+counter-rotate (diamond), before/after pseudo-elements (cylinder, cloud), skew (parallelogram).
- Drag-and-drop from library uses MIME type `application/bunny-diagram-node` (serialised `DiagramLibraryItem`).

### Trash integration

Registered as a trashable kind (`"diagram"`) via `registerTrashable`. Soft-delete renames to `__trash:<id>:<original>` to release the `UNIQUE(project, name)` constraint.

## Alternatives considered

**Mermaid / PlantUML as storage format:** Would produce more LLM-friendly text, but Mermaid's xyflow renderer is read-only; editing requires round-tripping text which adds complexity. xyflow native JSON keeps the editor and storage in sync.

**Per-diagram type custom components:** Ten separate node renderers would be harder to extend. A single `DiagramNode` component driven by a `shape` CSS class is simpler and covers all ten types without conditional rendering.

## Consequences

- Binary grows by the WASM grammars already loaded for code graph; no additional size impact.
- `diagram_node_library` global seeds are shared across all projects; per-project additions are project-scoped.
- SVG thumbnail capture uses `XMLSerializer` on the xyflow SVG; it reflects the xyflow viewport, not a full-page export.
- Diagrams are not translatable in v1 (no sidecar table). Can be added later following the `registerKind` pattern.
