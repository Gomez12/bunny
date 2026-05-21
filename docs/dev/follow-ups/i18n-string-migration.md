# Follow-up: Migrate remaining user-facing strings to i18n

## What remains

The [`i18n-introduction`](../plans/i18n-introduction.md) plan shipped the
framework (`react-i18next`), `en` + `nl` locale files, the
`bun run i18n:check` enforcement script, and a representative migration
covering `Sidebar.tsx`, `Modal.tsx`, `ConfirmDialog.tsx`, and three tab
call-sites (Projects / Trash / Contacts).

The vast majority of user-facing strings in `web/src/` are still
hardcoded. Concretely:

- All other tab files in `web/src/tabs/*.tsx` — every page header
  title/description/action label, every empty-state, every dialog title
  and message.
- All other components in `web/src/components/*.tsx` — toolbars, menu
  items, status text, validation messages.
- Page-level pages in `web/src/pages/*.tsx`.

## Why not done now

A wholesale migration is multi-day work, deserves component-by-component
review, and would balloon the i18n-introduction PR into something
unreviewable. The framework + enforcement script + a representative
sample land first; the rest is shipped incrementally.

## Next step

Migrate one tab per PR (or one component family per PR). Suggested
order, highest-traffic first:

1. `ChatTab` — done 2026-05-20. Empty-state, Quick Chat banner +
   toggle, drop-zone, regen/wait labels, error label, admin
   read-only note. Composer placeholders + slash-command labels live
   in `Composer.tsx` and remain hardcoded; migrate alongside the
   composer-family PR.
2. `BoardTab`, `TasksTab`, `PlanningTab` — done 2026-05-20.
   - `BoardTab`: title, group-tab, swimlane/archive confirms,
     loading state.
   - `TasksTab` + embedded `TaskDialog`: page header, table
     columns, section copy, status badge, dialog form
     labels/validation, action buttons.
   - `PlanningTab` shell: empty states + trash confirm. The
     planning sub-views (`PlanningRoadmapView`,
     `PlanningWishesView`, `PlanningDeadlinesView`,
     `PlanningTeamsView`, `PlanningTagsView`,
     `PlanningReportView`, `PlanningCalendarView`) still hold
     hardcoded copy and ship as a separate PR.
3. `AgentsTab`, `SkillsTab`, `KnowledgeBaseTab` — done 2026-05-21.
   - `AgentsTab` + `SkillsTab`: page header (Trans + `<code>` /
     `<link>` slots), card grid, project link chips, action
     buttons, install-from-URL modal, delete confirms.
   - `KnowledgeBaseTab` shell + `DefinitionsTab`: sub-tab label,
     search placeholder, empty states, card status/active chips,
     project badge, delete action.
   - The `DefinitionDialog`, `AgentDialog`, `SkillDialog`
     components still carry hardcoded copy and ship as a
     follow-up component-family PR.
4. `DiaryTab`, `WhiteboardTab`, `DiagramsTab`, `WorkspaceTab` —
   done 2026-05-21.
   - `WorkspaceTab` shell (5 sub-tab labels, aria-label, loading).
   - `DiaryTab` (title, new entry, empty state, list item,
     transcription status badges, delete confirm).
   - `WhiteboardTab` (composer placeholders, AI-edit overlay,
     edit-preview success / error strings, empty state).
   - `DiagramsTab` (gallery header, empty state, toolbar
     tooltips, AI overlay, unsaved badge, delete/aria labels,
     two setError() paths, trash confirm). The
     `DIAGRAM_TYPE_LABELS` constant still holds raw labels;
     migrate alongside the diagram-types refactor.
5. The remaining tabs (`FilesTab`, `BusinessesTab`,
   `IntegrationsTab`, `WebNewsTab`, `NotificationsTab`,
   `CodeTab`) — done 2026-05-21. `DiagramsTab` shipped with
   step 4. Each migration moved the static strings to `t()` /
   `<Trans>`; embedded sub-views (CodeShowCodeView,
   CodeChatView, CodeGraphView, CodeScriptsView,
   CodeSecretsView, news-template renderers, dialog
   components) and the dynamic-key lookups (e.g.
   DIAGRAM_TYPE_LABELS) remain as component-family follow-ups.
6. `pages/` — done 2026-05-21.
   - `LoginPage` (form labels, submit + submitting state,
     error fallback).
   - `ChangePasswordPage` (forced/voluntary titles, forced
     note, three form labels, submit + submitting, three
     error variants).
   - `SettingsPage` (nav, Suspense loading, profile +
     password forms, SoulForm, ScriptRuntimesForm with a
     static-key switch helper, GlobalCalendarSection,
     UserCalendarSection). LANGUAGE_OPTIONS deliberately
     keeps language names in their native script.
7. The rest of `components/` (forms, menus, popovers).

Each PR adds new keys to `en.json` / `nl.json`, runs
`bun run i18n:check`, and confirms `bun run check` is green.

Once every visible string is `t(…)`-wrapped, consider adding a
runtime locale-switcher in Settings (currently the language is detected
once from `navigator.language` and persisted in `localStorage` by
`i18next-browser-languagedetector`).

## Related files or docs

- [`AGENTS.md`](../../../AGENTS.md) §i18n
- [`../plans/i18n-introduction.md`](../plans/i18n-introduction.md)
- [`../../../web/src/i18n/index.ts`](../../../web/src/i18n/index.ts)
- [`../../../web/src/i18n/locales/en.json`](../../../web/src/i18n/locales/en.json)
- [`../../../scripts/i18n-check.ts`](../../../scripts/i18n-check.ts)

## Status

open
