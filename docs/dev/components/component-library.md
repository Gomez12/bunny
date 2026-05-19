# Component library

## At a glance

`web/src/components/` holds 57 shared components. Everything reusable beyond one tab lives here. Tab-specific UI lives inside `web/src/tabs/`.

Not every component in `components/` is equally shared — some are specialised (`BoardCard`, `CardRunLog`) and used only by their owning tab. This page indexes them by category.

## Layout + shell primitives

| Component | Purpose | Notes |
| --- | --- | --- |
| `Sidebar.tsx` | Primary 56 px icon rail (expands to 240 px on hover). | Defines the `NAV` groups. See [`./shell-and-navigation.md`](./shell-and-navigation.md). |
| `CodeRail.tsx` | Secondary 56 px icon rail inside the Code tab. | Same hover-expand geometry as the primary rail. |
| `PlanningRail.tsx` | Secondary icon rail inside the Planning tab. | Roadmap / Calendar / Wishes / Teams / Deadlines / Tags. |
| `ScriptsRail.tsx` | Secondary rail inside the Code → Scripts sub-app. | |

## Shared primitives

| Component | Purpose | Notes |
| --- | --- | --- |
| `EmptyState.tsx` | Empty-state illustration + message. | Uses the rabbit. Accepts `title`, `description`, optional `action`. Required for every list view that may be empty. |
| `StatusPill.tsx` | Small status badge. | `pending` / `translating` / `ready` / `error` / `idle` / `running` / …. Colour via semantic tokens. |
| `LangBadge.tsx` | Language code badge. | Used on translation tabs and next to entity titles in list rows. |
| `LanguageTabs.tsx` | Language tabstrip with source-badge + status pills. | Drops into any entity dialog. |
| `QueueWaitBadge.tsx` | "Waiting in queue" indicator inside chat bubbles. | Driven by the `queue.llm` gate state. |
| `MarkdownContent.tsx` | Renders markdown with code highlighting + mermaid. | Used by chat bubbles, KB panel, news templates. |
| `MermaidBlock.tsx` | Mermaid diagram renderer. | Deferred-loaded. Used by `MarkdownContent`. |
| `MessageBubble.tsx` | Chat bubble for one message (user / assistant / tool). | Handles edit / regen / fork affordances. Reads `message.author` to render `@name`. |
| `ReasoningBlock.tsx` | Dim-italic reasoning accordion. | Expand state from `users.expand_think_bubbles`. |
| `ToolCallCard.tsx` | One tool-call + tool-result pair. | Collapsible. Respects `users.expand_tool_bubbles`. |
| `UserQuestionCard.tsx` | `ask_user` interactive card. | Radio/checkbox + optional free-form. Disables on submit. |
| `ToastStack.tsx` | Toast container, top-right. | Used by notifications. |
| `NotificationBell.tsx` | Sidebar footer bell + unread badge. | Routes to the `notifications` tab on click. |
| `Rabbit.tsx` | Brand mascot. | See [`./icons-and-rabbit.md`](./icons-and-rabbit.md). |
| `Composer.tsx` | Chat input box + send button. | Used by the chat tab and elsewhere as the standalone prompt control. |
| `EntityComposer.tsx` | Edit/question mode toggle + prompt box. | Shared two-mode pattern used by `DocumentTab`, `WhiteboardTab`, and other content entities. |
| `TranslationsPanel.tsx` | Tabstrip + tabs for the translation UI. | Drops into every entity dialog. |
| `MemoryPanel.tsx` | Per-agent memory view + edit. | Used inside `AgentDialog`. |

## Tab side panels

These are full-height context columns that pair with a 1fr detail pane (260 px + 1fr layout).

| Component | Used by |
| --- | --- |
| `SessionSidebar.tsx` | Chat tab |
| `DocumentSidebar.tsx` | Documents tab |
| `DocumentRibbon.tsx` | Documents tab (top toolbar above the editor) |
| `WhiteboardSidebar.tsx` | Whiteboard tab |

## Tab-owned but lives here

Specialised components that live in `components/` for historical reasons but are used by a single tab.

| Component | Used by |
| --- | --- |
| `BoardCard.tsx`, `BoardColumn.tsx`, `CardRunLog.tsx` | Board tab |
| `DocumentEditor.tsx` | Documents tab |
| `WhiteboardCanvas.tsx` | Whiteboard tab |
| `StatsFooter.tsx` | Chat tab footer |
| `ProjectPromptsSection.tsx` | Workspace → Projects |
| `ApiKeyList.tsx`, `UserList.tsx` | Settings |
| `TelegramLinkCard.tsx` | Settings → Integrations |
| `CalendarExceptionEditor.tsx` | Planning → Calendar |

## Dialog primitives

Every modal in the app goes through the shared [`Modal.tsx`](../../../web/src/components/Modal.tsx) primitive — see styleguide §4 for the full contract (X/ESC/backdrop/footer, sizes, skeleton). 18 dialog components consume it:

| Dialog | Purpose |
| --- | --- |
| `Modal.tsx` | The shared primitive. Exports `Modal`, `Modal.Header`, `Modal.Body`, `Modal.Footer`. |
| `ConfirmDialog.tsx` | Generic confirmation. Used for all destructive actions — never roll a `window.confirm`. |
| `ProjectDialog.tsx` | Create/edit project. |
| `AgentDialog.tsx` | Create/edit agent. |
| `SkillDialog.tsx` | Create/edit/install skill. |
| `SwimlaneDialog.tsx` | Create/edit swimlane. |
| `CardDialog.tsx` | Create/edit board card + run log. |
| `ContactDialog.tsx` | Create/edit contact. |
| `ContactImportDialog.tsx` | vCard import preview. |
| `BusinessDialog.tsx` | Create/edit business. |
| `DefinitionDialog.tsx` | Create/edit KB definition + Generate buttons. |
| `TopicDialog.tsx` | Create/edit Web News topic. |
| `WhiteboardPickerDialog.tsx` | Pick a whiteboard for embedding. |
| `CodeProjectDialog.tsx` | Create/edit code project (clone repo). |
| `CodeProjectPickerDialog.tsx` | Pick a code project for embedding. |
| `NewChatWithAgentDialog.tsx` | Pick an agent and start a new chat. |
| `PlanningProjectDialog.tsx` | Create/edit planning project. |
| `PlanningProjectPickerDialog.tsx` | Pick a planning project for embedding. |
| `ScriptDialog.tsx` | Create/edit script. |

## Tab-scoped components

Anything that lives exclusively under one tab belongs either in `components/<tab>/` (currently `news/` and `tiptap/`) or inline inside `tabs/*.tsx`. New tab-specific UI should go there, not into the top of `components/`.

## Rules

- **If a primitive is used by more than one tab, it belongs in `components/`.** Otherwise keep it tab-local.
- **Re-export TS types alongside the component.** `MessageBubble.Props`, etc.
- **Primitives respect `currentColor` and tokens.** No inline colour values.
- **Primitives don't own network state.** Data flows in via props; mutations are the caller's responsibility.
- **Every dialog uses `<Modal>`.** Never roll your own backdrop or hand-wire ESC — the primitive owns all four close affordances (see styleguide §4).
- **Every destructive action uses `<ConfirmDialog>`.** Never `window.confirm`.
- **Every empty list view uses `<EmptyState>`.** Never ship a blank panel.

## Related

- [`./patterns.md`](./patterns.md) — recurring layouts built on these primitives.
- [`./icons-and-rabbit.md`](./icons-and-rabbit.md) — how `Rabbit` and icons fit in.
- [`./streaming-ui.md`](./streaming-ui.md) — how `MessageBubble`, `ToolCallCard`, `ReasoningBlock`, `UserQuestionCard` compose inside a live turn.
- [`../agents/add-a-ui-component.md`](../agents/add-a-ui-component.md) — when to put a component under `components/` vs tab-local.
