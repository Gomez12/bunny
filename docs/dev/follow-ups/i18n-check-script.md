# Follow-up: Implement `bun run i18n:check`

## What remains

`AGENTS.md` lists `bun run i18n:check` as a recommended pre-PR step. It must fail when:

- Translation keys are referenced in code but missing from a locale file.
- Locale files contain keys no longer used in code.
- Hardcoded user-facing strings appear outside the i18n layer.

None of this exists yet.

## Why not done now

Out of scope for the docs-restructure plan ([`../plans/docs-restructure.md`](../plans/docs-restructure.md)).

## Next step

- Add a `scripts/i18n-check.ts`.
- Add `i18n:check` to `package.json` scripts.
- Decide which locale file is the source of truth (English fallback per `AGENTS.md`).

## Related files or docs

- [`AGENTS.md`](../../../AGENTS.md)
- `web/src/i18n/` (current locale layout)

## Status

open
