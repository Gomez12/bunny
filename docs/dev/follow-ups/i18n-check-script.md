# Follow-up: Implement `bun run i18n:check`

## What remains

Nothing in this follow-up. `bun run i18n:check` ships as part of
[`../plans/i18n-introduction.md`](../plans/i18n-introduction.md) and is
wired into the `check` chain in `package.json`.

The script enforces:

- Every `t("…")` / `<Trans i18nKey="…">` reference under `web/src/`
  resolves in **both** `en.json` and `nl.json`.
- No orphan keys (every key in either locale file is referenced).
- Every English fallback string is non-empty (English is the primary
  fallback per `AGENTS.md` §i18n).

A smoke test at `tests/i18n/i18n-check.test.ts` spawns the script via
`Bun.spawn` and asserts a clean exit.

Wholesale migration of every hardcoded string is tracked separately in
[`./i18n-string-migration.md`](./i18n-string-migration.md).

## Related files or docs

- [`AGENTS.md`](../../../AGENTS.md) §i18n
- [`../plans/i18n-introduction.md`](../plans/i18n-introduction.md)
- [`../../../scripts/i18n-check.ts`](../../../scripts/i18n-check.ts)
- [`../../../tests/i18n/i18n-check.test.ts`](../../../tests/i18n/i18n-check.test.ts)
- [`../../../web/src/i18n/index.ts`](../../../web/src/i18n/index.ts)

## Status

done
