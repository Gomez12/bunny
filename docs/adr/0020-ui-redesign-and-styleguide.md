# ADR 0020 — UI Redesign: Sidebar Navigation, Icons, Mascot, and Styleguide

**Status:** Accepted
**Date:** 2026-04-17

## Context

The web UI grew to 14 top-level tabs in a single horizontal pill bar in `web/src/App.tsx`. Every tab was added organically (Dashboard → Chat → Messages → Board → Whiteboard → Documents → Contacts → Files → Tasks → Projects → Agents → Skills → Logs → Settings), each with its own header and empty-state treatment, no shared icon system, and no reinforcement of the "bunny" brand beyond the wordmark. Visual drift across tabs was becoming visible, and there was no canonical reference contributors could point to when making design decisions.

## Decision

### Navigation

- Replace the horizontal pill bar with a **240 px left sidebar** grouped into four labeled sections: **Work** (Chat, Board, Tasks), **Content** (Documents, Whiteboard, Files, Contacts), **Configure** (Workspace), **System** (Dashboard, Settings). Collapses to a 56 px icon-rail at 900 px, hamburger drawer at 500 px.
- Consolidate 14 tabs down to 10:
  - `Messages` merges into the `Chat` session sidebar (it was already a project-scoped session list).
  - `Projects`, `Agents`, `Skills` collapse into one `Workspace` tab with inner sub-tabs — reusing the sub-tab pattern already present in `SettingsPage.tsx`.
  - `Logs` becomes an admin-only sub-tab of `Settings`.
- The active-project pill and user chip + logout move into the sidebar (header and footer respectively). The topbar is removed.

### Visual system

- Adopt `lucide-react` as the single icon library. All icons are re-exported from `web/src/lib/icons.ts` with fixed conventions (18 px default, stroke-width 1.75, `currentColor`) so the styleguide has one authoritative source to list.
- Introduce shared primitives: `Sidebar`, `PageHeader`, `Card`, `EmptyState`. Existing tab-specific classes stay working — migration is additive, one tab at a time.
- Add a **rabbit mascot** (single mono-color SVG in `web/src/assets/rabbit.svg`) with four sanctioned placements: brand logo (20 px, replaces `.brand-dot`), subtle watermark (fixed, opacity 0.04, not on Dashboard), empty-state illustrations (120 px via `EmptyState`), login/change-password hero (160 px).

### Styleguide

- New canonical reference at **`docs/styleguide.md`** covering tokens, typography, layout primitives, components, icon system, mascot usage, SSE UI patterns, empty/loading/error states, accessibility, and a dated change log. Linked from `docs/README.md` and pointed to from `CLAUDE.md` under **Conventions** so it surfaces in every Claude Code session.

## Consequences

- Backend, schema and HTTP surface are unchanged.
- `Tab` union in `App.tsx` narrows (`messages`, `logs`, `projects`, `agents`, `skills` drop out; `workspace` is added). `localStorage` values for the dropped tabs fall back to the default (`chat`) on load.
- `lucide-react` added to `web/package.json`. Tree-shaking keeps the bundle impact in the single-digit KB range for the icons actually imported.
- Future UI changes must keep `docs/styleguide.md` in sync — it's load-bearing, not decorative. The styleguide ends with a change-log section so drift is visible.
