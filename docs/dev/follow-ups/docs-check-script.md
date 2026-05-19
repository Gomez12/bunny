# Follow-up: Implement `bun run docs:check`

## What remains

`AGENTS.md` §"Pull Requests" prescribes `bun run docs:check` and lists what it must enforce:

- Every plan in `docs/dev/plans/` is referenced from `docs/dev/tasklist.md`.
- `docs/dev/tasklist.md` keeps at most 50 `done` rows.
- Every `job.kind` registered by `registerAllAgents` / `registerTaxonomyPurgeHandlers` appears in the matching table of `docs/dev/architecture/job-inventory.md`. Same diff also runs from `tests/docs/job-inventory.test.ts`.

None of these checks exist yet. There is no `docs:check` script in `package.json` and no `tests/docs/job-inventory.test.ts`.

## Why not done now

Out of scope for the docs-restructure plan ([`../plans/docs-restructure.md`](../plans/docs-restructure.md)). Restructure first, tooling second.

## Next step

- Add a `scripts/docs-check.ts` with the three checks.
- Add `docs:check` to `package.json` scripts.
- Add the companion `tests/docs/job-inventory.test.ts`.

## Related files or docs

- [`AGENTS.md`](../../../AGENTS.md)
- [`../tasklist.md`](../tasklist.md)
- [`../architecture/job-inventory.md`](../architecture/job-inventory.md)

## Status

open
