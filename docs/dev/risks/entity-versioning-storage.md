# Risk — entity_versions storage growth

## Description

`entity_versions` stores one JSON snapshot per save event across 23 registered kinds. Heavy-edit kinds (whiteboards with embedded base64 PNGs, large code projects, planning roadmaps) can accumulate snapshots fast, pushing `db.sqlite` size beyond what users expect from a personal app.

## Impact

- Disk pressure on the user's machine.
- Slower `VACUUM` / backup operations.
- Larger Electron bundle exports when the app ships state.

## Likelihood

Moderate. The default cap (200 saves per entity) plus daily prune keep growth bounded, but a single whiteboard that gets edited 200 times with a 500 KB embedded screenshot still costs ~100 MB before pruning kicks in.

## Mitigation

- `maxSnapshotBytes` (default 1 MB) caps any single row; oversized payloads are dropped to `{}` and flagged.
- `maxVersionsPerEntity` (default 200) caps the `save` chain per entity. Lifecycle markers are kept forever.
- Content-hash dedup skips no-op writes.
- Daily `versioning.prune` scheduler handler enforces the cap.
- Per-kind `redact` strips secret-shaped columns; the same hook can be used to drop bulky fields if needed.
- Whiteboard screenshots already shrink to 256 px for the LLM screenshot (commit `cf3e1ca`), reducing the worst case.

## Owner / area

Memory / storage layer — `src/memory/versioning.ts`, `src/memory/versioning_prune_handler.ts`.

## Status

**Open — monitored.** The mitigations are in place; the risk is whether the defaults are right. Re-evaluate once real usage data is available from the dashboard (`db.sqlite` size over time per project).
