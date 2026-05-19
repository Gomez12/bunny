# Write a test

## When you need this

You're adding or changing behaviour. That behaviour needs a test. `bun:test` is the runner; `tests/` mirrors `src/`.

## Layout

`src/agent/loop.ts` → `tests/agent/loop.test.ts`. Always mirror. A new test file in a place without a matching source file is a code smell.

## Basic shape

```ts
import { describe, expect, test, beforeEach } from "bun:test";

describe("thing under test", () => {
  test("does the expected behaviour", () => {
    const result = doTheThing("input");
    expect(result).toBe("expected");
  });
});
```

Name tests after the **behaviour**, not the function. `"persists the new value"` beats `"setProjectPriority"`.

## DB tests

Every DB test gets its own temp DB. Never share a handle.

```ts
import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../../src/memory/db";
import { createProject } from "../../src/memory/projects";

describe("projects", () => {
  let db: Database;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "bunny-"));
    db = openDb(join(dir, "bunny.db"));
  });

  test("creates a project with a normalised name", () => {
    createProject(db, { name: "alpha", createdBy: null });
    const row = db.query("SELECT name FROM projects WHERE name = ?").get("alpha");
    expect(row).toMatchObject({ name: "alpha" });
  });
});
```

The temp dir is cleaned up automatically (Bun + OS); no explicit teardown needed.

## HTTP route tests

Construct a fake `ctx` and call the handler directly. Routes are plain functions — they don't need a running server.

```ts
import { describe, expect, test } from "bun:test";
import { handleSetThing } from "../../src/server/my_routes";

test("handleSetThing returns 404 when missing", async () => {
  const ctx = {
    db: /* temp db */,
    queue: { log: () => {} },
    user: { id: "u1", role: "user", username: "alice" },
    cfg: {} as any,
  } as AuthRouteCtx;
  const res = await handleSetThing(ctx, "nonexistent", { value: "x" });
  expect(res.status).toBe(404);
});
```

## Run

```sh
bun test                              # full suite
bun test tests/agent/loop.test.ts     # single file
bun test -t "persists the new value"  # single test by name
bun test --watch                      # watch mode
```

Coverage (if using `bun test --coverage`) writes to `./coverage/`.

## Rules

- **One concept per test.** Use `describe` to group; `test` for the single behaviour.
- **Temp DB per test (or per `beforeEach`).** Sharing causes flaky tests.
- **No sleeps, no retries.** If the code is async, `await`. If it schedules work, call the scheduler directly.
- **No network.** Mock or stub providers; run offline.
- **Fixtures live under `tests/fixtures/`** if they're shared. Otherwise inline.
- **Test names describe behaviour.** Not the function name.

## What to test

- Happy path.
- Error paths — not found, forbidden, invalid input.
- Edge cases — empty list, deduplication, race conditions.
- Invariants — if a function's contract is "never mutates X", assert X is unchanged.

## Don't test

- The framework. Bun itself is tested upstream.
- Third-party libs. Trust their test suites.
- Style. Use Prettier.

## Related

- [`../concepts/agent-loop.md`](../concepts/agent-loop.md) — the agent loop has dedicated tests under `tests/agent/`.
- `tests/` — there's usually a reference example next to your target module.
