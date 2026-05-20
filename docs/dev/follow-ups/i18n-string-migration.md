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

1. `ChatTab` (composer placeholders, empty state, slash-command labels).
2. `BoardTab`, `TasksTab`, `PlanningTab` (card actions, status pills).
3. `AgentsTab`, `SkillsTab`, `KnowledgeBaseTab` (definition dialogs).
4. `DiaryTab`, `WhiteboardTab`, `DiagramsTab`, `WorkspaceTab`.
5. The remaining tabs (`FilesTab`, `BusinessesTab`, `IntegrationsTab`,
   `WebNewsTab`, `NotificationsTab`, `CodeTab`, `DiagramsTab`).
6. `pages/`.
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
