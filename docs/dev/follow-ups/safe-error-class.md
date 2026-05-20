# Follow-up: Introduce `SafeError` for response-safe error messages

## What remains

`src/util/error.ts::errorMessage()` currently extracts the first line of any
`Error.message` and exposes it through `json({ error })` in the route handlers.
CodeQL's `js/stack-trace-exposure` rule (alert #13) still flags this flow
because `Error.message` is a recognised taint source for that query and the
ad-hoc `.split("\n")[0]` / length cap added in the code-scanning-alerts task
is not a sanitizer the query understands.

Defence-in-depth is in place, but the alert will not auto-close without a
proper barrier.

## Why not done now

Touches ~50 call-sites in `src/server/*_routes.ts` plus every `throw new
Error("…")` site whose message is intended to reach the user. Done as a
separate change so the diff is reviewable and we can land it with its own
tests.

## Next step

1. Add `class SafeError extends Error` in `src/util/error.ts` with a
   `safeMessage: string` field (and an optional `httpStatus`).
2. Update `errorMessage(e: unknown)` so that:
   - `e instanceof SafeError` → `e.safeMessage`
   - any other `Error` → a generic `"Internal error"` (and log the real
     message at `warn` level for diagnostics)
   - non-`Error` values → `String(e)` first-line, capped.
3. Migrate validator / domain throws under `src/business/**` and
   `src/server/**` from `throw new Error("…")` to `throw new SafeError("…")`
   where the message is intentionally user-facing.
4. Verify the next CodeQL scan closes alert #13.

## Related files or docs

- `src/util/error.ts`
- `src/server/*_routes.ts`
- `docs/dev/follow-ups/code-scanning-alerts.md`

## Status

open
