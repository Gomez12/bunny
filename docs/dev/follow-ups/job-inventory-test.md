# Follow-up: Add `tests/docs/job-inventory.test.ts`

## What remains

`AGENTS.md` expects a test at `tests/docs/job-inventory.test.ts` that runs the
same diff as `bun run docs:check` for the job inventory — every `job.kind`
registered via the per-domain `register…Handler` helpers wired in
`src/server/index.ts` must appear in
[`../architecture/job-inventory.md`](../architecture/job-inventory.md).

## Why not done now

Closed by `tests/docs/job-inventory.test.ts`. Kept as a follow-up reference
until `bun run docs:check` ([`./docs-check-script.md`](./docs-check-script.md))
exposes the same diff at the CLI level.

## Next step

Wire the same comparison into `bun run docs:check` so it runs outside Bun's
test runner too.

## Related files or docs

- [`./docs-check-script.md`](./docs-check-script.md)
- [`../architecture/job-inventory.md`](../architecture/job-inventory.md)
- [`../../../tests/docs/job-inventory.test.ts`](../../../tests/docs/job-inventory.test.ts)

## Status

done
