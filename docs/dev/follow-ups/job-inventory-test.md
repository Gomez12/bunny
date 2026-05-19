# Follow-up: Add `tests/docs/job-inventory.test.ts`

## What remains

`AGENTS.md` expects a test at `tests/docs/job-inventory.test.ts` that runs the same diff as `bun run docs:check` for the job inventory — every `job.kind` registered by `registerAllAgents` / `registerTaxonomyPurgeHandlers` must appear in [`../architecture/job-inventory.md`](../architecture/job-inventory.md).

## Why not done now

Depends on `bun run docs:check` ([`./docs-check-script.md`](./docs-check-script.md)) and on `job-inventory.md` being populated.

## Next step

After `docs:check` and the populated job inventory exist, write the test that imports the registration helpers and compares against the markdown table.

## Related files or docs

- [`./docs-check-script.md`](./docs-check-script.md)
- [`../architecture/job-inventory.md`](../architecture/job-inventory.md)

## Status

open
