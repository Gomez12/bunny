# Shell and navigation

## At a glance

The shell is a permanent **56 px left icon-rail** that expands to 240 px on hover as an absolutely-positioned overlay (VS Code pattern — no layout reflow). Below 640 px the rail collapses to a hamburger drawer.

One router (`web/src/App.tsx`) maps a `NavTabId` union to a tab component. `localStorage` holds the active tab, active project, and active session. Legacy tab ids are aliased forward so bookmarks don't break.

## Where it lives

- `web/src/App.tsx` — top-level router, boot-time `/api/auth/me` gate, `LEGACY_TAB_ALIAS`, deep-link parsing.
- `web/src/components/Sidebar.tsx` — the rail + drawer + nav groups + footer (bell, user, theme, logout).
- `web/src/styles.css` — `.nav__*` classes, `.app-shell__main` layout.
- `web/src/components/NotificationBell.tsx` — the unread-badge bell in the nav footer.
- `web/src/components/Rabbit.tsx` + `web/src/assets/rabbit.svg` — brand logo + 0.04-opacity watermark.

## Nav groups

Defined inline in `Sidebar.tsx`:

```ts
const NAV: NavGroup[] = [
  { label: "Overview",  items: [{ id: "dashboard", icon: LayoutDashboard }] },
  { label: "Work",      items: [{ id: "chat", icon: MessageCircle },
                                 { id: "board", icon: Kanban }] },
  { label: "Content",   items: [{ id: "documents", icon: FileText },
                                 { id: "whiteboard", icon: Palette },
                                 { id: "files", icon: Folder },
                                 { id: "contacts", icon: Users },
                                 { id: "knowledge-base", icon: Library },
                                 { id: "news", icon: Newspaper }] },
  { label: "Configure", items: [{ id: "tasks", icon: Clock }] },
];
```

The `Settings`, `Notifications`, and project picker live in the footer, not inside `NAV`. Adding a new tab means appending to the relevant group *and* extending the `NavTabId` union.

`NavTabId` currently includes `notifications` and `workspace` even though they're not in `NAV` — the bell routes to `notifications`; the project picker routes to `workspace`.

## Context columns vs full-width tabs

Some tabs own a secondary column inside the main area (list sidebar + detail pane):

- **Chat** — `SessionSidebar`.
- **Documents** — `DocumentSidebar`.
- **Whiteboard** — `WhiteboardSidebar`.
- **Contacts** — groups sidebar.
- **Notifications** — list pane.

Others fill the full width (Dashboard, Board, Tasks, Files, Knowledge Base, News, Workspace, Settings).

This split is expressed as layout inside the tab, not at the shell level. The shell just gives each tab the full `.app-shell__main` area.

## `localStorage` keys

| Key | Value |
| --- | --- |
| `bunny.activeTab` | `NavTabId`. Persists the selected tab. Default: `chat`. |
| `bunny.activeProject` | Project name. Persists the current project. Switching project starts a fresh session. |
| `bunny.activeSessionId` | Session id. Persists across reloads. |
| `bunny.webNews.template` | Template id for the Web News tab (`list` / `newspaper`). |
| `bunny.theme` | `light` / `dark`. Optional. |

## `LEGACY_TAB_ALIAS`

`App.tsx` maps old tab ids to current ones so external bookmarks don't break:

| Legacy id | Current id |
| --- | --- |
| `messages` | `chat` |
| `logs` | `settings` (then sub-tab) |
| `projects` / `agents` / `skills` | `workspace` |

Never remove an alias — removing one breaks old links.

## Deep links

`App.tsx` parses `window.location` on boot:

```
?tab=chat&project=<project>&session=<sessionId>#m<messageId>
```

Used by notifications (`NotificationDto.deepLink`) and external shares. The parse runs once; subsequent in-app navigation uses state, not the URL.

## Boot-time auth gate

`App.tsx` calls `GET /api/auth/me` with `credentials: "include"` on mount:

- 401 → login page.
- `mustChangePassword = true` → forced change-password page.
- Success → mount the main shell with `user` in context.

Every subsequent fetch uses `credentials: "include"` so the `bunny_session` cookie rides along. See `./state-and-hooks.md`.

## Rules

- **Icons through the barrel only.** `web/src/lib/icons.ts`. See `./icons-and-rabbit.md`.
- **Never hard-code a tab id outside `NavTabId`.** Add to the union first.
- **Never remove a `LEGACY_TAB_ALIAS` entry.**
- **The rail is absolutely-positioned on hover-expand.** Do not change it to push content; that regresses the VS Code feel.
- **The bell lives in `.nav__user-row` (sibling to `.nav__user`).** Moving it breaks the collapsed-rail badge visibility — see [ADR 0027](../../adr/0027-user-notifications.md).

## Related

- [`../../styleguide.md`](../../styleguide.md) — canonical visual spec.
- [ADR 0006 — Web UI](../../adr/0006-web-ui.md)
- [ADR 0020 — UI redesign & styleguide](../../adr/0020-ui-redesign-and-styleguide.md)
- [`./icons-and-rabbit.md`](./icons-and-rabbit.md)
- [`./state-and-hooks.md`](./state-and-hooks.md)
- [`../how-to/add-a-nav-tab.md`](../how-to/add-a-nav-tab.md) — step-by-step.
