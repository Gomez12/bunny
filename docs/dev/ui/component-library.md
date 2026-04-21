# Component library

## At a glance

`web/src/components/` holds ~45 shared primitives. Everything reusable beyond one tab lives here. Tab-specific UI lives inside `web/src/tabs/`.

Not every component in `components/` is equally shared — some are specialised (`BoardCard`, `CardRunLog`) and used only by their owning tab. This page indexes the *genuinely shared* primitives.

## Shared primitives

| Component | Purpose | Notes |
| --- | --- | --- |
| `EmptyState.tsx` | Empty-state illustration + message. | Uses the rabbit. Accept `title`, `description`, optional `action`. |
| `StatusPill.tsx` | Small status badge. | `pending` / `translating` / `ready` / `error` / `idle` / `running` / …. Colour via semantic tokens. |
| `LangBadge.tsx` | Language code badge. | Used on translation tabs. |
| `LanguageTabs.tsx` | Language tabstrip with source-badge + status pills. | Drops into any entity dialog. |
| `MarkdownContent.tsx` | Renders markdown with code highlighting + mermaid. | Used by chat bubbles, KB panel, news templates. |
| `MermaidBlock.tsx` | Mermaid diagram renderer. | Deferred-loaded. Used by `MarkdownContent`. |
| `MessageBubble.tsx` | Chat bubble for one message (user / assistant / tool). | Handles edit / regen / fork affordances. Reads `message.author` to render `@name`. |
| `ReasoningBlock.tsx` | Dim-italic reasoning accordion. | Expand state from `users.expand_think_bubbles`. |
| `ToolCallCard.tsx` | One tool-call + tool-result pair. | Collapsible. Respects `users.expand_tool_bubbles`. |
| `UserQuestionCard.tsx` | `ask_user` interactive card. | Radio/checkbox + optional free-form. Disables on submit. |
| `ToastStack.tsx` | Toast container, top-right. | Used by notifications. |
| `NotificationBell.tsx` | Sidebar footer bell + unread badge. | Routes to the `notifications` tab on click. |
| `Rabbit.tsx` | Brand mascot. | See `./icons-and-rabbit.md`. |
| `Composer.tsx` | Chat input box + send button. | Re-used by the chat tab and (in simplified form) by `DocumentComposer` / `WhiteboardComposer`. |
| `DocumentComposer.tsx` / `WhiteboardComposer.tsx` | Edit/ask mode toggle + prompt box. | Same two-mode pattern for each content entity. |
| `TranslationsPanel.tsx` | The tabstrip + tabs for the translation UI. | Used inside every entity dialog. |

## Dialog primitives

Every entity has a dialog. They share structure (header + tabs + footer with Save/Cancel) but don't currently share a base component — that's an open refactor.

| Dialog | Purpose |
| --- | --- |
| `ProjectDialog.tsx` | Create/edit project. |
| `AgentDialog.tsx` | Create/edit agent. |
| `SkillDialog.tsx` | Create/edit/install skill. |
| `SwimlaneDialog.tsx` | Create/edit swimlane. |
| `CardDialog.tsx` | Create/edit board card + run log. |
| `ContactDialog.tsx` | Create/edit contact. |
| `ContactImportDialog.tsx` | vCard import preview. |
| `DefinitionDialog.tsx` | Create/edit KB definition + Generate buttons. |
| `TopicDialog.tsx` | Create/edit Web News topic. |
| `WhiteboardPickerDialog.tsx` | Pick a whiteboard for embedding. |

## Tab-scoped components

Anything that lives exclusively under one tab belongs either in `components/<tab>/` (e.g. `components/news/`) or inline inside `tabs/*.tsx`. `news/`, `tiptap/` are the current sub-directories.

## Rules

- **If a primitive is used by more than one tab, it belongs in `components/`.** Otherwise keep it tab-local.
- **Re-export TS types alongside the component.** `MessageBubble.Props`, etc.
- **Primitives respect `currentColor` and tokens.** No inline colour values.
- **Primitives don't own network state.** Data flows in via props; mutations are the caller's responsibility.
- **Dialogs use the portal pattern** (rendered into `document.body`) via the native `<dialog>` element. Don't invent new modal containers.

## Related

- [`./patterns.md`](./patterns.md) — recurring layouts built on these primitives.
- [`./icons-and-rabbit.md`](./icons-and-rabbit.md) — how `Rabbit` and icons fit in.
- [`./streaming-ui.md`](./streaming-ui.md) — how `MessageBubble`, `ToolCallCard`, `ReasoningBlock`, `UserQuestionCard` compose inside a live turn.
- [`../how-to/add-a-ui-component.md`](../how-to/add-a-ui-component.md) — when to put a component under `components/` vs tab-local.
