# Follow-up — i18n for entity history UI

## What remains

The universal version-history UI (`HistoryButton`, `EntityHistoryModal`, ADR 0046) ships with inline English strings:

- `"Show version history"` (HistoryButton `aria-label`).
- Modal title `"History — {entityName}"`.
- Sidebar source labels (`SOURCE_LABELS` in `EntityHistoryModal.tsx`): `Saved`, `Before delete`, `Before restore`, `Restored`, `Manual snapshot`, `Imported`.
- Status/empty/error strings: `"Loading versions…"`, `"No versions yet. Edits made from now on will be tracked here."`, `"Loading snapshot…"`, `"Select a version on the left."`, `"Snapshot unavailable — payload exceeded the size cap and was not stored."`.
- Buttons: `"Close"`, `"Restore this version"`, `"Restoring…"`.
- Confirm dialog title/body/label: `"Restore this version?"`, `"The current state will be captured as a pre_restore snapshot first, so you can roll back."`, `"Restore"`.

## Why not done now

Bunny has no project-wide i18n library wired into the web client yet. Every existing UI feature ships inline English labels and waits for the eventual i18n pass (tracked elsewhere in `docs/dev/follow-ups/`). Adding ad-hoc i18n for this one feature would create an inconsistent precedent.

The AGENTS.md rule "User-facing text must use i18n" is acknowledged but not enforceable until the library lands.

## Next step

When the global i18n library is added:

1. Pick stable keys: `entityHistory.button.label`, `entityHistory.modal.title`, `entityHistory.source.<source>`, `entityHistory.restore.confirmTitle`, `entityHistory.restore.confirmBody`, `entityHistory.restore.confirmLabel`, `entityHistory.empty`, `entityHistory.snapshotUnavailable`, `entityHistory.snapshotOversized`.
2. Replace the inline strings in `web/src/components/HistoryButton.tsx` and `web/src/components/EntityHistoryModal.tsx`.
3. Re-run `bun run i18n:check` (when that script exists; see `docs/dev/follow-ups/i18n-check-script.md`) to confirm no missing keys.

## Related files / docs

- `web/src/components/HistoryButton.tsx`
- `web/src/components/EntityHistoryModal.tsx`
- ADR 0046 — `docs/dev/decisions/0046-entity-versioning.md`
- Architecture — `docs/dev/architecture/entities/entity-versioning.md`
- Companion follow-up — `docs/dev/follow-ups/i18n-check-script.md`

## Status

**Open** — waiting on global i18n library decision. No tasklist row yet; will be folded into the global i18n migration when that lands.
