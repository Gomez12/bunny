# Your first change

A guided walkthrough to get muscle memory for four of the most common tasks. Total time: ~30 minutes. The goal is touch, not polish — follow it once, then come back to the relevant concept page.

## Before you start

- Run `bun test` once and make sure it's green.
- Open `CLAUDE.md` in another tab — it's the authoritative reference while you work.

## 1. Add a queue log line

Every HTTP mutation logs through the queue. Let's add one to a route that doesn't yet (imaginary example — in practice the routes already log).

**Pattern:**

```ts
void ctx.queue.log({
  topic: "project",       // domain noun
  kind: "create",         // verb or dotted verb
  userId: ctx.user.id,    // always when an authenticated user is available
  data: { projectName },  // no secrets, ever
});
```

Rules:

- `void` — fire-and-forget. Never `await`; logging must not block the response.
- `topic` is a domain noun: `project`, `board`, `auth`, `agent`, `task`, `workspace`, `apikey`, `user`, `session`, `document`, `whiteboard`, `contact`, `kb`, `web_news`, `trash`, `telegram`, `notification`.
- `kind` is a verb or dotted verb: `create`, `update`, `delete`, `card.move`, `login.failed`, `soft.delete`.
- Never include passwords, API-key values, bot tokens, webhook secrets. Log `tokenTail` (last 4) if a token is in scope.

Run `bun test tests/queue/` to confirm nothing broke.

Deep dive → [`../concepts/queue-and-logging.md`](../concepts/queue-and-logging.md).

## 2. Add a column to a table

The schema is **append-only**. Never drop or rename columns — migrations ship into a live `$BUNNY_HOME` that nobody owns.

1. Open `src/memory/schema.sql`. Find the table (e.g. `projects`). Add the new column at the bottom of the column list with a safe default:
   ```sql
   priority  INTEGER NOT NULL DEFAULT 0,
   ```
2. Open `src/memory/db.ts`. If the column needs a backfill-on-upgrade path (i.e. existing databases), add an `ALTER TABLE … ADD COLUMN …` inside `migrateColumns`.
3. Update the DTO type in the same module (`src/memory/projects.ts`) and any `SELECT …` statements that list columns explicitly.
4. If the new column should be in the API response, update the route that returns it and the frontend type in `web/src/api.ts`.

Rule of thumb: if you find yourself wanting to *rename* or *drop* a column, stop — write an ADR explaining why the rename is worth breaking portable state, then reconsider.

Deep dive → [`../reference/data-model.md`](../reference/data-model.md).

## 3. Add an HTTP route

Routes live in per-domain modules under `src/server/` and are dispatched by a switch in `src/server/routes.ts:handleApi`. No framework, just pathname + verb.

1. Pick (or create) the module, e.g. `src/server/project_routes.ts`.
2. Add a handler. The context type tells you what's in scope (`db`, `queue`, `user`, `cfg`, …):
   ```ts
   export async function handleSetPriority(
     ctx: AuthRouteCtx,
     projectName: string,
     body: { priority: number },
   ): Promise<Response> {
     const project = getProject(ctx.db, projectName);
     if (!project) return new Response("not found", { status: 404 });
     if (!canEditProject(ctx.db, ctx.user, project)) return new Response("forbidden", { status: 403 });
     setProjectPriority(ctx.db, projectName, body.priority);
     void ctx.queue.log({
       topic: "project",
       kind: "update",
       userId: ctx.user.id,
       data: { projectName, priority: body.priority },
     });
     return Response.json({ ok: true });
   }
   ```
3. Wire it into `handleApi` in `src/server/routes.ts`:
   ```ts
   if (url.pathname.startsWith("/api/projects/") && url.pathname.endsWith("/priority") && req.method === "PATCH") {
     const name = /* extract */;
     return handleSetPriority(ctx, name, await req.json());
   }
   ```
4. Add to `docs/http-api.md` and the entity page under `docs/dev/entities/`.

Gotchas:

- **Auth is at the switch, not the handler.** `authenticate` runs before `handleApi`; if the route should be public (webhook endpoints) it must be mounted *before* the auth gate — see how `/api/telegram/webhook/:project` is wired in `routes.ts`.
- **Always log mutations.** The single missing log line is the classic bug — events then drop silently from the admin audit tab.

Deep dive → [`../how-to/add-an-http-route.md`](../how-to/add-an-http-route.md).

## 4. Write a test

Tests live under `tests/` mirroring `src/`. Use `bun:test`; DB tests use `mkdtempSync` + `openDb(path)` for isolation.

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/memory/db";
import { createProject, setProjectPriority } from "../../src/memory/projects";

describe("setProjectPriority", () => {
  test("persists the new value", () => {
    const dir = mkdtempSync(join(tmpdir(), "bunny-"));
    const db = openDb(join(dir, "bunny.db"));
    createProject(db, { name: "alpha", createdBy: null });
    setProjectPriority(db, "alpha", 5);
    const row = db.query("SELECT priority FROM projects WHERE name = ?").get("alpha") as { priority: number };
    expect(row.priority).toBe(5);
  });
});
```

Run:

```sh
bun test tests/memory/projects.test.ts
bun test -t "persists the new value"
```

Deep dive → [`../how-to/write-a-test.md`](../how-to/write-a-test.md).

## Pre-commit checklist

Before `git commit`:

1. `bun run check` (typecheck + test) — green.
2. Updated `README.md` if the user-facing workflow changed.
3. Updated `docs/README.md` + an ADR in `docs/adr/` for non-trivial architectural changes.
4. Updated the matching page in `docs/dev/`.
5. Updated `CLAUDE.md` if conventions, build steps, or the high-level architecture shifted.
6. English everywhere (commit message, PR body, comments, identifiers, logs).

Deep dive → [`conventions.md`](./conventions.md).
