# Follow-up — load `[versioning]` from `bunny.config.toml`

## What remains

`src/memory/versioning.ts` exposes `configureVersioning(partial)` and ships sensible in-process defaults:

```ts
const DEFAULT_CONFIG = {
  debounceMinutes: 5,
  maxSnapshotBytes: 1_048_576,
  maxVersionsPerEntity: 200,
};
```

The plan ([`../plans/entity-revision-history.md`](../plans/entity-revision-history.md)) calls for these to be read from a `[versioning]` block in `bunny.config.toml`:

```toml
[versioning]
debounce_minutes        = 5
max_versions_per_entity = 200
max_snapshot_bytes      = 1048576
prune_interval_hours    = 24
```

That loader is not wired yet. `configureVersioning` is currently called only from tests; production runs on the defaults.

## Why not done now

The defaults work for every observed workload. Operator tunability is nice-to-have, not required for the v1 cut documented in ADR 0046. Adding a TOML section now would also require deciding how `prune_interval_hours` interacts with the existing scheduler seed (`versioning.prune` already runs daily via the scheduler, not via this config knob).

## Next step

When demand surfaces (a user reports needing a different cap), add:

1. A `[versioning]` block in `bunny.config.toml` with the four keys above.
2. A loader call in `src/server/index.ts` (alongside other config wiring) that runs `configureVersioning({ … })` before the first `recordVersion`.
3. Decide whether `prune_interval_hours` should reschedule the `versioning.prune` cron or stay an unused stub.
4. Update `docs/dev/architecture/entities/entity-versioning.md` ("Configuration" section) to drop the "operator tunability is a follow-up" note.

## Related files / docs

- `src/memory/versioning.ts` (`configureVersioning`, `DEFAULT_CONFIG`).
- `src/memory/versioning_prune_handler.ts` (`versioning.prune`).
- ADR 0046 — `docs/dev/decisions/0046-entity-versioning.md`.
- Plan — `docs/dev/plans/entity-revision-history.md`.

## Status

**Open — not blocking.** No tasklist row; reopen one if a user-facing tuning need surfaces.
