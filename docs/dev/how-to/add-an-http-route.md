# Add an HTTP route

## When you need this

A new endpoint — `GET /api/foo`, `POST /api/foo/:id/bar`, whatever. The project doesn't use a framework; routing is a `switch` on `url.pathname` + `req.method` in `src/server/routes.ts`.

## Steps

1. **Pick or create the module.** Routes live in `src/server/<domain>_routes.ts`. Example: `src/server/project_routes.ts`.

2. **Write the handler.** The context type depends on whether auth is required:
   ```ts
   // src/server/my_routes.ts
   import type { AuthRouteCtx } from "./auth_middleware";
   import { getMyThing, setMyThing } from "../memory/my_thing";

   export async function handleGetThing(
     ctx: AuthRouteCtx,
     thingId: string,
   ): Promise<Response> {
     const thing = getMyThing(ctx.db, thingId);
     if (!thing) return new Response("not found", { status: 404 });
     return Response.json(thing);
   }

   export async function handleSetThing(
     ctx: AuthRouteCtx,
     thingId: string,
     body: { value: string },
   ): Promise<Response> {
     const thing = getMyThing(ctx.db, thingId);
     if (!thing) return new Response("not found", { status: 404 });
     // Permission check.
     if (!canEdit(ctx.user, thing)) return new Response("forbidden", { status: 403 });

     setMyThing(ctx.db, thingId, body.value);

     void ctx.queue.log({
       topic: "my_thing",
       kind: "update",
       userId: ctx.user.id,
       data: { thingId, value: body.value },
     });

     return Response.json({ ok: true });
   }
   ```

3. **Wire the switch.** In `src/server/routes.ts:handleApi`:
   ```ts
   if (url.pathname.startsWith("/api/things/")) {
     const id = url.pathname.slice("/api/things/".length);
     if (req.method === "GET")   return handleGetThing(ctx, id);
     if (req.method === "PATCH") return handleSetThing(ctx, id, await req.json());
   }
   ```
   Mount **more specific** routes before generic ones (board routes are mounted before project routes).

4. **Document.** Add the new endpoint to:
   - `docs/http-api.md` (canonical API reference).
   - The entity page under `docs/dev/entities/` (orientation for devs).

5. **Test.** `tests/server/my_routes.test.ts` — call the handler with a stubbed ctx.

## Rules

- **`void ctx.queue.log({ … })` on every mutation.** Read routes don't log.
- **Permission check before mutation.** `canSee*` for reads; `canEdit*` for writes.
- **Auth is at the switch, not the handler.** `authenticate` runs before `handleApi`.
- **Public endpoints mount *before* the auth gate.** See `src/server/routes.ts` for how the Telegram webhook is wired — constant-time secret compare, always returns 200, dispatch detached.

## `ctx` types

The route context varies by feature:

| Type | Carries |
| --- | --- |
| `AuthRouteCtx` | `db`, `queue`, `cfg`, `user` |
| `WorkspaceRouteCtx` | Above + project-scope helpers |
| `AgentRouteCtx` / `BoardRouteCtx` / `ScheduledTaskRouteCtx` | Domain-specific additions |

All ctx types carry `queue: BunnyQueue`. Nothing is ever off-limits for logging.

## Validation

```sh
bun test tests/server/my_routes.test.ts
```

Manual:

```sh
curl -X PATCH http://localhost:3000/api/things/abc \
  -H "Cookie: bunny_session=<your-cookie>" \
  -H "Content-Type: application/json" \
  -d '{"value":"hello"}'
```

Then verify the `events` row landed:

```sh
bun run src/index.ts --session <any> "list events for topic my_thing"
# or open Settings → Logs in the UI.
```

## Related

- [`../concepts/queue-and-logging.md`](../concepts/queue-and-logging.md)
- [`../concepts/auth.md`](../concepts/auth.md)
- `docs/http-api.md` — the canonical endpoint reference.
