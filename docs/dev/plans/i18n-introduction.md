# Plan: Introduce i18n to the web frontend

## Goal

`AGENTS.md` mandates i18n for user-facing text and lists `bun run i18n:check`
as a pre-PR step. The web frontend currently has no i18n framework at all:
no `react-i18next`, no locale files, no `t()` calls. This plan introduces
the framework, ships English + Dutch locales, migrates a representative
sample of shared UI strings, and wires `bun run i18n:check` so future
hardcoded strings fail the check chain.

A wholesale string migration is multi-day work; that is explicitly
deferred (see [Follow-up: i18n string migration](../follow-ups/i18n-string-migration.md)).

## Scope (this PR)

- Add `react-i18next` + `i18next` + `i18next-browser-languagedetector` to
  `web/package.json`.
- Create `web/src/i18n/index.ts` that initialises `i18next` with both
  locales and the language-detector plugin (browser language with `en`
  fallback per `AGENTS.md` §i18n).
- Create `web/src/i18n/locales/en.json` (primary fallback) and
  `web/src/i18n/locales/nl.json` (Dutch — user is Dutch-speaking).
- Import the i18n module from `web/src/main.tsx` so it initialises before
  React mounts.
- Migrate ~30 representative strings:
  - `Sidebar.tsx` — nav group labels, item labels, theme + logout button
    text, `aria-label`s for drawer + settings.
  - `ConfirmDialog.tsx` — default `confirmLabel` / `cancelLabel`.
  - `Modal.tsx` — `aria-label="Close"`.
  - One `PageHeader` caller (`ProjectsTab`) — title / description / action
    text.
  - Two `EmptyState` callers (`TrashTab`, `ContactsTab`) — title +
    description.
  - One `ConfirmDialog` caller (`ProjectsTab`) — title + message.
- Add `scripts/i18n-check.ts` and wire it into the `check` chain.
- Add `tests/i18n/i18n-check.test.ts` (green-path smoke).

## Non-goals

- Migrating every hardcoded string in every tab. Tracked in
  [`../follow-ups/i18n-string-migration.md`](../follow-ups/i18n-string-migration.md).
- Backend / server error messages — those are a separate concern and
  `AGENTS.md` only requires the i18n on user-facing UI text.
- A locale-switcher UI. Browser language is the source of truth for now;
  a settings UI is a follow-up.
- Pluralisation / interpolation polish. The introduced keys are flat
  strings; richer features are added when needed.

## Approach

### Framework choice

`react-i18next` + `i18next`. Industry standard, supports React 19, small
runtime cost (~5 kB gzip), zero dependencies on Node-only APIs. The
`i18next-browser-languagedetector` plugin handles `navigator.language` →
locale resolution with `localStorage` persistence.

### Locale-file layout

**Flat** key namespace, one JSON object per locale. `AGENTS.md` §i18n
already shows dotted keys (`auth.login.title`, `auth.login.submit`,
`auth.login.error.invalidCredentials`) without any namespace separator,
so we follow that. The JSON is structured as a single nested object so
keys read naturally:

```json
{
  "nav": {
    "groups": { "overview": "Overview" },
    "items": { "dashboard": "Dashboard" }
  },
  "common": { "ok": "OK", "cancel": "Cancel", "close": "Close" }
}
```

### Key-naming convention

- All-lowercase, dot-separated dot-paths.
- First segment is the area: `nav`, `common`, `confirm`, `tab.<name>`,
  etc.
- Verbs/nouns reflect intent, not the literal English string (e.g.
  `nav.theme.lightLabel`, not `nav.lightMode`).
- aria-labels go under `<area>.a11y.<purpose>` to keep them grouped
  separately from visible text.

### Check script (`scripts/i18n-check.ts`)

Three rules:

1. **No missing keys** — every key referenced via `t("…")` or
   `<Trans i18nKey="…">` in `web/src/**` exists in both `en.json` and
   `nl.json`.
2. **No orphan keys** — every key in either locale file is used in
   `web/src/**`.
3. **Non-empty fallback** — every key in `en.json` has a non-empty
   string value.

Dynamic key calls (`t(variable)`, `t(\`prefix.${x}\`)`) are **skipped**
rather than failed. A literal-string regex match catches the static
cases. The script exits 0 on clean, 1 on any violation, with a per-rule
breakdown.

### Pre-PR check

`bun run check` chain gains `bun run i18n:check` as the final step. The
smoke test at `tests/i18n/i18n-check.test.ts` spawns the script via
`Bun.spawn` and asserts a clean exit.

## Affected modules

- `web/package.json` (add deps)
- `web/src/main.tsx` (initialise i18n)
- `web/src/i18n/index.ts`, `web/src/i18n/locales/en.json`,
  `web/src/i18n/locales/nl.json` (new)
- `web/src/components/Sidebar.tsx`, `Modal.tsx`, `ConfirmDialog.tsx`
  (migrate defaults / aria-labels)
- `web/src/tabs/ProjectsTab.tsx`, `TrashTab.tsx`, `ContactsTab.tsx`
  (migrate sampled strings)
- `scripts/i18n-check.ts` (new)
- `tests/i18n/i18n-check.test.ts` (new)
- `package.json` (`i18n:check` script + `check` chain)

## Tests

- `tests/i18n/i18n-check.test.ts` — spawns `bun run i18n:check`; expects
  exit 0 with the current locale + code state.
- Existing component tests in `web/` are zero — no fixtures need an
  `I18nextProvider` wrapper.

## Docs impact

- Update [`../follow-ups/i18n-check-script.md`](../follow-ups/i18n-check-script.md)
  to status `done`.
- Create [`../follow-ups/i18n-string-migration.md`](../follow-ups/i18n-string-migration.md)
  capturing the un-migrated areas (the rest of the tabs).
- Update `docs/dev/tasklist.md`: flip the i18n-check-script row to
  `done` and add a row for the new follow-up.

## i18n impact

The whole point. After this PR, the contract "user-facing strings are
i18n keys" is enforceable for migrated areas.

## Accessibility impact

`aria-label`s in `Sidebar.tsx` and `Modal.tsx` are migrated alongside
visible text — accessibility text gets the same i18n treatment.

## Risks

- **Bundle size** — `react-i18next` + `i18next` adds ~15 kB gzip.
  Acceptable; no lazy-load split needed yet.
- **Locale bundle bloat over time** — both JSON files are imported
  eagerly. Once `nl.json` grows past ~50 kB we should switch to
  `i18next-http-backend` or dynamic `import()`.
- **`bun add --cwd web`** — if it fails, fall back to running inside
  `web/`. The Bun lockfile must end up consistent either way.

## Open questions

- Do we want a runtime locale-switch UI in settings, or is browser
  language enough? Deferred to the string-migration follow-up.
- Should server error codes also feed into the frontend's i18n
  dictionary? Out of scope.
