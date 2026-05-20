# Follow-up: Implement `bun run docs:check`

## What remains

Nothing. `bun run docs:check` is implemented and wired into `bun run check`.

## History

`AGENTS.md` §"Pull Requests" prescribes `bun run docs:check`. As shipped it enforces:

- Every `*.md` under `docs/dev/plans/` (except the `README.md` directory index) is referenced from `docs/dev/tasklist.md`.
- `docs/dev/tasklist.md` keeps at most 50 rows whose status column is exactly `done`.
- Every `job.kind` registered via `registry.register(KIND_HANDLER, …)` in `src/` appears in `docs/dev/architecture/job-inventory.md`, and vice versa. Same diff also runs from [`tests/docs/job-inventory.test.ts`](../../../tests/docs/job-inventory.test.ts); both share helpers in [`scripts/_lib/job_inventory.ts`](../../../scripts/_lib/job_inventory.ts).

The script is at [`scripts/docs-check.ts`](../../../scripts/docs-check.ts) and runs from [`tests/docs/docs-check.test.ts`](../../../tests/docs/docs-check.test.ts) as a green-path smoke test.

## Related files or docs

- [`AGENTS.md`](../../../AGENTS.md)
- [`../tasklist.md`](../tasklist.md)
- [`../architecture/job-inventory.md`](../architecture/job-inventory.md)

## Status

done
