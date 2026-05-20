# Risk — entity_versions migration / backfill performance

## Description

On the first `openDb()` after the universal versioning system landed, two migrations run:

1. The `entity_versions` table + indexes are created.
2. Every existing `script_versions` row is mirrored into `entity_versions` with `source='backfill'`.

Both are idempotent (`CREATE TABLE IF NOT EXISTS`, `INSERT OR IGNORE` keyed on `UNIQUE(kind, entity_id, version)`), but the backfill copies every row in `script_versions`. Databases that already accumulated thousands of script versions can stall app startup briefly.

## Impact

- Visible startup delay the first time a user opens the new build.
- On extremely large databases (tens of thousands of script versions), the backfill could time out a constrained boot path.

## Likelihood

Low. `script_versions` is the only legacy chain mirrored, and most users have well under a thousand rows. The migration runs in a single SQLite transaction; rolled-out builds have shown sub-second backfills in normal usage.

## Mitigation

- `INSERT OR IGNORE` makes repeat runs free — a partial backfill on the first start can complete on the next.
- The legacy `script_versions` table is preserved. If the backfill ever needs to be reset, dropping `entity_versions` rows with `source='backfill'` is enough to redo it.
- Future kinds with very large existing tables (e.g. planning_wishes on a long-running roadmap) should batch their initial backfill in 1000-row transactions if one is ever added. None ships today — the only kind backfilled is `script`.

## Owner / area

Memory / migrations — `src/memory/db.ts` (`migrateColumns`), `src/memory/versioning.ts` (backfill helper).

## Status

**Open — monitored.** No incidents reported. Re-evaluate if a user reports slow startup after upgrading to a build that ships ADR 0046.
