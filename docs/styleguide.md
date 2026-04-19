# Bunny Styleguide

The canonical visual reference for the Bunny web UI. Contributors and Claude Code should consult this doc before adding new UI. If a value in here contradicts the code, **fix one of them** — don't ignore the drift.

Dual theme (light + dark). The default palette under `:root` is dark; `[data-theme="light"]` overrides the same tokens for the light palette. `web/src/App.tsx` writes the `data-theme` attribute on `<html>` from `localStorage.bunny.theme`, falling back to `prefers-color-scheme` on first load. A Sun/Moon button in the sidebar footer toggles between them. Bun ≥ 1.3.0, React + Vite, plain CSS with custom properties (no Tailwind, no CSS-in-JS). All tokens live at the top of `web/src/styles.css`.

---

## 1. Design tokens

### Colors

| Token | Dark | Light | Use |
| --- | --- | --- | --- |
| `--bg` | `#0f1115` | `#ffffff` | Page root / main content area |
| `--bg-elevated` | `#171a21` | `#f7f8fa` | Cards, dialogs, assistant message bubbles |
| `--bg-sidebar` | `#0b0d12` | `#eef0f4` | Navigation chrome, composer rails |
| `--border` | `#23272f` | `#dde1e8` | 1 px borders, separators |
| `--text` | `#e6e8ee` | `#1a1d22` | Primary body text |
| `--text-dim` | `#9aa0aa` | `#5b6270` | Secondary / meta text, placeholders |
| `--text-faint` | `#6b7280` | `#8b919c` | Tertiary captions, disabled labels |
| `--accent` | `#7c5cff` | `#6849f4` | Primary action, active state, brand dot |
| `--accent-soft` | `#5b47bf` | `#a394ff` | Accent outline on active pills |
| `--user-bg` | `#2a2f3a` | `#eef0f4` | User message bubble background |
| `--assistant-bg` | `#171a21` | `#f7f8fa` | Assistant message bubble (same as elevated) |
| `--tool-bg` | `#141823` | `#f2f4f8` | Tool-call / tool-result blocks |
| `--ok` | `#22c55e` | `#16a34a` | Success / healthy status |
| `--err` | `#ef4444` | `#dc2626` | Error / destructive |
| `--code-bg` | `#1e1e2e` | `#1e1e2e` | Preformatted / syntax-highlighted blocks (stays dark in both themes so `github-dark.css` keeps working) |
| `--code-fg` | `#cdd6f4` | `#cdd6f4` | Code text inside `--code-bg` |
| `--inline-code-bg` | `rgba(255,255,255,.08)` | `rgba(0,0,0,.06)` | Inline `<code>` tint |
| `--shadow-soft` | `rgba(0,0,0,.35)` | `rgba(15,17,22,.08)` | Default card shadow |
| `--hover-bg` | `rgba(255,255,255,.03)` | `rgba(15,17,22,.04)` | Row hover tint (tables, feeds, logs) |
| `--hairline` | `rgba(255,255,255,.05)` | `rgba(15,17,22,.06)` | Ultra-subtle separator |

**Rules:**
- No new hex literals in component CSS — add a token or reuse one. If you need a one-off semantic (e.g. a warning amber), add it to the token table and document it here.
- When you add a rule that depends on "this surface is dark", add a matching `[data-theme="light"]` override — or reach for a token that already flips. Hardcoded `rgba(255,255,255,…)` for hover tints / hairlines is a smell: use `--hover-bg` / `--hairline`.
- `color-scheme: dark` / `color-scheme: light` is set on `:root` / `[data-theme="light"]` — this flips native scrollbars and form controls automatically.

### Spacing scale

Use powers of 4 — `4 / 8 / 12 / 16 / 20 / 24 / 32`. Most gaps across the codebase settle on `8` (tight), `12` (comfortable), `16` (section), `20` (card padding). Don't invent fractional values.

### Radius

| Context | Value |
| --- | --- |
| Cards, bubbles, dialogs | `var(--radius)` = `12 px` |
| Buttons, inputs | `8 px` |
| Pills, chips, circular nav items | `999 px` |
| Avatar gradients | `50%` |

### Shadows

Use the accent as an outline-glow rather than drop shadows. The one-off `box-shadow: 0 0 8px var(--accent)` on the brand dot is the reference. For active pills, use `box-shadow: 0 0 0 1px var(--accent-soft)`.

---

## 2. Typography

- Body stack: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif`.
- Base size `14 px`, line-height `1.55`.
- Monospace: `var(--font-mono)` = `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`. Used for code blocks, tool-call payloads, SSE debug output.
- Headings: 600 weight, letter-spacing `0.02em` on the wordmark. No special display font.

No italic body copy except reasoning-channel text in the Chat stream, which is intentionally dim + italic to set it apart from content.

---

## 3. Layout primitives

### Shell

Two-column grid: **56 px icon rail** + `1fr` main. Defined as `.app-shell` in `styles.css`. The rail sits as an absolutely-positioned overlay inside the grid — on `:hover` / `:focus-within` it expands to 240 px as an overlay above the main area (VS Code pattern) without reflowing the content. Labels, group headers, project pill and user chip fade in only when the rail is expanded.

Tabs that need a context column (Chat, Documents, Whiteboard, Contacts) keep their own internal two-column grid (`260 px context sidebar + 1fr`) inside the main area. Tabs without a context column (Board, Tasks, Files, Workspace, Dashboard, Settings) fill the full main area. This keeps the navigation minimal by default and surfaces tab-specific sub-navigation only when it's meaningful.

Breakpoints:
- `max-width: 640 px` — rail becomes a hamburger drawer (hidden until the menu button is tapped). Backdrop overlay closes it on click.

### Page header (planned)

Tabs currently hand-roll their own header markup (`<h1>` + toolbar row). A shared `<PageHeader title description actions>` primitive is planned — when introduced, every tab should adopt it and this section will document its exact API. Until then, match the existing sizing: title 18 px, 600 weight; description 12 px, `--text-dim`; actions slot right-aligned, 8 px gap.

### Card grid

Auto-fill `minmax(280px, 1fr)` grid, `16 px` gap. Card surfaces currently live in tab-specific classes (`.project-card`, `.agent-card`, `.skill-card`, `.contact-card`, `.dash-kpi`). They share padding (`20 px`), border (`1 px solid var(--border)`), and radius (`12 px`). A shared `<Card variant>` primitive that consolidates these is planned — prefer the existing classes for now rather than inventing new ones.

### Sub-tabs

Within a tab (e.g. Workspace: Projects | Agents | Skills, Settings: Profile | API keys | Users | Logs), use the inline segmented-control pattern from `SettingsPage.tsx`. Sub-tabs live at the top of the content area, below the `<PageHeader>`, and use `.btn--ghost` with an `aria-current="page"` on the active one.

---

## 4. Components

### Buttons

| Class | Purpose |
| --- | --- |
| `.btn` | Default — neutral bg, 1 px border, 8 px radius |
| `.btn--send` | Primary action — accent fill, white text |
| `.btn--stop` | Destructive / cancel — `--err` fill, white text |
| `.btn--ghost` | Transparent, no border — use in toolbars and sub-tabs |
| `.btn--attach` | Chat composer attach button — circular |

Height settles around 28-32 px. Don't introduce a new `.btn--foo` variant without adding it to this table.

### Dialogs

All dialogs share the `.dialog` class family (see `ProjectDialog`, `AgentDialog`, `CardDialog`, `ContactDialog`, `SwimlaneDialog`, `SkillDialog`). Fixed backdrop + centered card, `--radius` 12 px, 480-640 px max-width depending on form density. Close via X button *or* ESC. Always include a "Cancel" ghost button next to the primary action.

### Forms

- Labels: dim text, 13 px, stacked above inputs.
- Inputs: `--bg` background, `--border` border, 8 px radius, 8 px padding.
- Required fields marked with a single `*` in the label — no red outline by default.
- Validation errors render below the field in `--err`.

### Composer

The chat/document/whiteboard/contacts composers all share the same footprint: textarea + send button + optional mode toggle + optional attach button. Reuse `Composer.tsx` or match its dimensions (min-height 44 px, max-height 220 px).

### Empty states

Every tab with a list that may be empty uses `<EmptyState>`:

```tsx
<EmptyState title="No contacts yet" description="Add one or import a vCard." action={<button className="btn btn--send">New contact</button>} />
```

Always includes the rabbit mascot at 120 px, centered, above the title.

---

## 5. Icon system

- **Source:** `lucide-react` only. Don't import from other libraries, and don't use emoji for UI (emoji are fine inside user content).
- **Barrel:** all icons re-exported from `web/src/lib/icons.ts`. New icons added to the UI must be added to the barrel first — the barrel is the sanctioned icon set.
- **Size:** 18 px default, 16 px inline in running text, 20 px in the brand lockup. The `size` prop on lucide icons sets both width and height.
- **Stroke-width:** `1.75`. Don't mix stroke-widths across a single view.
- **Color:** `currentColor`. Never hard-code a fill — let the parent set the text color.

Sanctioned icon usage at the time of writing (see `web/src/lib/icons.ts` for the up-to-date list):

| Context | Icon |
| --- | --- |
| Chat | `MessageCircle` |
| Board | `Kanban` |
| Tasks | `Clock` |
| Documents | `FileText` |
| Whiteboard | `Palette` |
| Files | `Folder` |
| Contacts | `Users` |
| Knowledge Base | `Library` |
| Workspace | `Package` |
| Dashboard | `LayoutDashboard` |
| Settings | `Settings` |
| Create | `Plus` |
| Search | `Search` |
| Edit | `Pencil` |
| Delete | `Trash2` |
| Download / export | `Download` |
| Upload / import | `Upload` |
| Copy | `Copy` |
| Confirm | `Check` |
| Close / cancel | `X` |
| Disclosure | `ChevronRight` |
| Run | `Play` |
| Pause | `Pause` |
| Refresh | `RefreshCw` |
| Error | `AlertCircle` |
| Info | `Info` |
| Protected root | `Lock` |
| User | `User` |
| Agent | `Bot` |
| Skill | `Sparkles` |
| Logout | `LogOut` |
| Language (surface) | `Globe` |
| Language (tool) | `Languages` |
| Notifications (idle) | `Bell` |
| Notifications (has unread) | `BellRing` |
| Mention target | `AtSign` |

---

## 6. Rabbit mascot

Four sanctioned placements — nowhere else.

| Placement | Size | Opacity | Notes |
| --- | --- | --- | --- |
| Brand logo | 20 px | 1.0 | Sidebar header, replaces the old `.brand-dot` |
| Background watermark | 180-240 px | 0.04 | Fixed-position, bottom-right of `.main`. **Not on Dashboard** (too dense). Non-interactive (`pointer-events: none`). |
| Empty state | 120 px | 0.85 | Centered above the title in `<EmptyState>` |
| Auth hero | 160 px | 1.0 | Above the form on Login / Change Password pages |

**Don'ts**

- Don't put the rabbit inside data tables, lists, or card contents.
- Don't show more than one rabbit on a single screen (brand + watermark is fine because the watermark is subliminal at 0.04).
- Don't scale below 16 px — it loses detail.
- Don't recolor. The SVG uses `currentColor`; let the parent text color decide.

---

## 7. SSE UI patterns

The SSE event shapes are defined in `src/agent/sse_events.ts` and shared between backend and frontend. Each event maps to a specific visual treatment; respect the mapping so new agent-facing UIs stay consistent.

| Event | UI |
| --- | --- |
| `content` | Plain text in the assistant bubble, streamed. |
| `reasoning` | Collapsible block above the answer, dim italic, `--text-dim`. |
| `tool_call` | `ToolCallCard` — bordered card with `--tool-bg`, tool name as header, args folded. |
| `tool_result` | Appended to the matching `ToolCallCard`, truncated with "expand" affordance. |
| `usage` | Silent — feeds `StatsFooter`. |
| `stats` | `StatsFooter` update. |
| `error` | Red inline banner in the stream. |
| `turn_end` / `done` | Stops spinners, unlocks composer. |
| `card_run_started` / `card_run_finished` | Updates `CardRunLog` state in Board. |
| `notification_created` | Prepends to the notification panel, bumps the bell badge, pushes a `Toast` (top-right) and fires an OS notification — suppressed when the user is already viewing the target session. |
| `notification_read` | Marks the matching rows read in the panel and decrements the bell badge (multi-tab sync). |

Events may carry `author` (agent name) — when set, render `@name` instead of the default `assistant` label.

---

## 8. Empty / loading / error states

- **Empty:** `<EmptyState>` with rabbit + title + optional CTA. Never ship a blank screen.
- **Loading:** inline `Loading…` text with the existing `.app-loading` class for full-screen, or a small spinner from `lucide-react` (`Loader2` with `animate-spin`) for in-panel loads. No skeleton screens (adds weight for little gain).
- **Error:** red banner (`--err` on `--bg-elevated`) with an `AlertCircle` icon + message + optional retry button. Never swallow errors silently; if a fetch fails, say so.

---

## 9. Accessibility

- Every interactive element has a visible focus ring. Lean on the browser default unless the default is invisible against the element background — then add `outline: 2px solid var(--accent); outline-offset: 2px`.
- Active nav items carry `aria-current="page"`. Active sub-tabs carry `aria-current="page"` too.
- Dialogs trap focus, restore focus to the trigger on close, close on ESC.
- Color is never the sole signal. Status chips include an icon (`CheckCircle` / `AlertCircle`) alongside the color.
- All icons used as the sole content of a button must have an `aria-label`.
- **Future:** keyboard shortcuts for tab switching (e.g. `⌘1` … `⌘9`) — tracked but not yet implemented.

---

## 10. Change log

- **2026-04-17** — Initial styleguide. Introduced sidebar navigation (10 items in 4 groups), `lucide-react` icon system via `web/src/lib/icons.ts`, rabbit mascot (brand / watermark / empty / auth), shared primitives `Sidebar` / `EmptyState`. Tab count 14 → 10. See [ADR 0020](./adr/0020-ui-redesign-and-styleguide.md).
- **2026-04-18** — Switched to a 56 px icon-rail that expands to 240 px on hover as an overlay (VS Code pattern), restoring the tab-owned context columns (Chat, Documents, Whiteboard, Contacts sidebars). Fixes the layout regression where an always-on 240 px sidebar collided with tabs that carry their own sidebar.
- **2026-04-18** — Added **Knowledge Base** nav item (icon: `Library`) in the Content group. New card shape `.kb-card` (same 20 px padding / 12 px radius / auto-fill grid as `.contact-card` / `.project-card`) with status chips (`.kb-chip--idle|--generating|--ok|--cleared|--error|--active|--project`). Dialog reuses the `.modal.modal--wide` shell. New icons in the barrel: `Library`, `Eraser`, `ExternalLink`. See [ADR 0021](./adr/0021-knowledge-base-definitions.md).
- **2026-04-18** — Added multi-language translation primitives. New components: `<LanguageTabs>` (pill-shaped tabstrip, source tab highlighted with a filled `LangBadge`, translation tabs carry a `<StatusPill>`), `<LangBadge>` (compact 2-letter uppercase pill in accent colour — used next to entity titles in list rows to show source language), `<StatusPill>` (generic status pill, reuses `.kb-chip` variants; statuses: `up-to-date` / `translating` / `stale` / `pending` / `failed` / `source` / `orphaned`), `<TranslationsPanel>` (drops into every entity dialog; tabstrip + read-only translation body + "Translate now" button; polls every 5 s while any row is transient). New CSS classes: `.lang-badge`, `.lang-tabs`, `.lang-tab`, `.lang-tab--active`, `.lang-tab--source`, `.lang-readonly` (+ `--empty` modifier), `.lang-readonly__header`, `.lang-readonly__translate-btn`, `.lang-readonly__error`. New icons in the barrel: `Globe`, `Languages`. See [ADR 0022](./adr/0022-multi-language-translation.md).
- **2026-04-19** — **Added user notifications.** Bell button with unread badge sits in a new `.nav__user-row` (sibling to `.nav__user` so the badge survives the hover-only opacity on the username label). Clicking the bell navigates to the Notifications **tab** (a full two-pane bunny view — `web/src/tabs/NotificationsTab.tsx`, CSS `.notif-tab` / `.notif-tab__list` / `.notif-tab__detail`) rather than opening a popover: the popover kept getting clipped by the main content area, and the tab offers room for a proper "All / Unread" filter and a detail pane with a primary "Open conversation" CTA. New components: `<NotificationBell>` (sidebar-footer navigation button, first click also requests OS-notification permission), `<NotificationsTab>` (list + detail), `<ToastStack>` (fixed top-right, auto-dismiss 5 s, hover-pause). Hook `useNotifications` owns fetch + SSE reconciliation; `osToast` shim feature-detects Tauri and routes to `@tauri-apps/plugin-notification` or falls back to `window.Notification`. New icons in the barrel: `Bell`, `BellRing`, `AtSign`. New SSE events surface `notification_created` / `notification_read` for realtime push (per-user fanout with 25 s keepalive). See [ADR 0027](./adr/0027-user-notifications.md).
- **2026-04-18** — **Introduced light theme.** Palette defined on `[data-theme="light"]` mirroring every existing token (bg / text / accent-soft / user-bg / tool-bg / etc.) plus new tokens for theme-aware surfaces: `--code-bg` / `--code-fg` (kept dark in both modes for `github-dark.css` compatibility), `--inline-code-bg`, `--overlay-bg`, `--shadow-soft`, `--hover-bg`, `--hairline`. `App.tsx` drives the `data-theme` attribute on `<html>`, persists to `localStorage.bunny.theme`, and follows OS `prefers-color-scheme` until the user makes an explicit choice. Sidebar footer gains a Sun/Moon toggle (class `.nav__theme`, matches `.nav__logout` shape). New icons in the barrel: `Sun`, `Moon`. Replaced hardcoded dark hexes (`#0b0d12`, `#1e1e2e`, `#1a1d23`) and `rgba(255,…)` hover tints with the new tokens across `styles.css`.
