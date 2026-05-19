# Plan: Restructure `docs/` to match `AGENTS.md`

## Goal

Bring `docs/` into the shape prescribed by [`AGENTS.md`](../../../AGENTS.md) §"Docs Structure" so the rules in that file (tasklist, plans, decisions, risks, follow-ups, dev/user split) are enforceable against the repository as it actually exists.

## Scope

- Create `docs/dev/tasklist.md` and `docs/dev/tasklistarchive.md`.
- Create all AGENTS-mandated folders under `docs/dev/` and `docs/user/`.
- Move all 45 ADR files from the old top-level `adr/` folder into [`../decisions/`](../decisions/) (preserve history with `git mv`).
- Move the top-level `styleguide.md`, `http-api.md`, `tools.md`, `errors.md` to their AGENTS slots under [`../styleguide/`](../styleguide/), [`../api/`](../api/) and [`../troubleshooting/`](../troubleshooting/).
- Rename existing `docs/dev/` subfolders to AGENTS names:
  - `concepts/` → `architecture/`
  - `getting-started/` → `setup/`
  - `ui/` → `components/`
  - `how-to/` → `agents/`
  - `entities/` → `architecture/entities/`
  - `reference/` → `architecture/reference/`
- Rewrite all internal cross-references in markdown and source code.

## Non-goals

- Implementing `bun run docs:check` and `bun run i18n:check` (tracked as separate follow-ups; AGENTS.md mentions them but they do not exist).
- Populating `architecture/job-inventory.md` with the live job list (placeholder only; tracked as a follow-up).
- Authoring new user-facing docs under `docs/user/` (placeholders only).
- Touching `docs/api/` — TypeDoc owns it (`cleanOutputDir: true`).

## Approach

1. Scaffold tasklist + all missing folders with README placeholders (without this, AGENTS workflow is not bootable).
2. `git mv` ADRs in bulk.
3. `git mv` other top-level docs and rename `docs/dev/` subfolders.
4. Rewrite cross-references with `sed`-style replacement across `docs/`, `src/`, `web/src/`, `README.md`.
5. Verify with `grep` that no old paths remain.

## Affected modules

- All of `docs/`.
- Markdown references in `README.md` and TypeScript files (`src/memory/calendar.ts`, `src/server/calendar_routes.ts`, `web/src/components/Rabbit.tsx`, `web/src/components/EmptyState.tsx`, `web/src/lib/icons.ts`, `web/src/components/LangBadge.tsx`).

## Tests

No production behavior changes. Run `bun run typecheck`, `bun test`, and `bun run docs` (TypeDoc) to confirm nothing references moved markdown via code.

## Docs impact

This entire plan is a docs refactor. See also [`../follow-ups/docs-check-script.md`](../follow-ups/docs-check-script.md) for the supporting tooling.

## i18n impact

None.

## Accessibility impact

None.

## Risks

- TypeDoc `readme: "docs/README.md"` still points at a valid file.
- Broken anchors inside ADRs are pre-existing and out of scope.
- `cleanOutputDir: true` on `docs/api/` means that folder is regenerated on every `bun run docs`; nothing handwritten should live there.

## Open questions

- Should `entities/` become a peer of `architecture/` instead of a subfolder? Current decision: nest under `architecture/` to keep AGENTS shape strict.
- Should `how-to/` move to `agents/` or somewhere else? Current decision: `agents/` (closest AGENTS slot for extension recipes).
