# UI

The frontend (`web/**`) has its own `package.json`, build, and component tree, so it's a peer of [`../concepts/`](../concepts/) rather than a subfolder. A dev who is only doing UI today can stay inside this folder and still have the complete picture.

The canonical visual spec is [**`docs/styleguide.md`**](../../styleguide.md) — tokens, spacing scale, icon sanctioning, rabbit mascot placements. This folder is the dev-oriented orientation layer on top.

## Read order

1. [**shell-and-navigation**](./shell-and-navigation.md) — how the sidebar, rail, drawer, and tab router fit together; `localStorage` keys; deep-link parsing.
2. [**design-system**](./design-system.md) — tokens, spacing, typography overview. Links down into the styleguide.
3. [**icons-and-rabbit**](./icons-and-rabbit.md) — icon barrel rule (never import `lucide-react` directly) and where the rabbit mascot appears.
4. [**component-library**](./component-library.md) — shared primitives map: `EmptyState`, `StatusPill`, `LangBadge`, `MessageBubble`, `ToolCallCard`, `ReasoningBlock`, etc.
5. [**patterns**](./patterns.md) — recurring UI patterns: sidebar-list-plus-detail, composer with edit/ask modes, modal dialogs, card grids, optimistic drag-and-drop.
6. [**state-and-hooks**](./state-and-hooks.md) — localStorage keys, hooks (`useSSEChat`, `useNotifications`), `credentials: "include"` rule, boot-time `GET /api/auth/me` gate.
7. [**streaming-ui**](./streaming-ui.md) — SSE via `fetch` body-reader (not `EventSource`), the `Turn` state machine, interactive cards.
8. [**tiptap-extensions**](./tiptap-extensions.md) — authoring custom Tiptap nodes; markdown roundtrip via `tiptap-markdown`.

## What's not here

- Per-tab walkthroughs live under [`../entities/`](../entities/) (one page per user-facing entity, with its UI sub-section).
- Recipe-style "how do I add a new tab?" guides live under [`../how-to/`](../how-to/).
