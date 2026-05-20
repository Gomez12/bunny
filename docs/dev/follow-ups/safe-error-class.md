# Follow-up: Introduce `SafeError` for response-safe error messages

## What remains

The barrier is in place — the only remaining work is the CodeQL re-scan
that will close alert `js/stack-trace-exposure` (#13). Bunny cannot run
CodeQL locally; the rescan happens automatically on push to `main`.

A handful of validator throws in `src/memory/**` and `src/planning/**`
still use `throw new Error(...)` for user-facing messages. They are
masked by the new `errorMessage()` so they no longer leak, but converting
them to `SafeError` would restore the original wording in the response.
Deferred as low-priority polish (see "Deferred" below).

## What landed

- New `src/util/error.ts`:
  - `class SafeError extends Error` with `safeMessage`, optional
    `httpStatus`, and standard `Error.cause` plumbing.
  - `errorMessage(e)` — response-safe; returns `INTERNAL_ERROR_MESSAGE`
    (`"Internal error"`) for any non-`SafeError` `Error`. This is the
    CodeQL barrier.
  - `errorDetails(e)` — the old behaviour, renamed; returns the first
    line of `Error.message` capped to 200 chars. For log lines, DB
    columns, queue payloads, stderr, and tool plumbing only.
  - `errorStatus(e, fallback)` — pulls the `httpStatus` out of a
    `SafeError`, defaulting to `fallback`.
  - `logUnexpectedError(queue, e, context)` — pushes a warn-level event
    to the bunqueue log for any non-`SafeError` so diagnostics aren't
    lost when the response is masked.
- ~45 non-response call-sites of `errorMessage` migrated to
  `errorDetails` (handlers, scheduler, tool wrappers, telegram, web_news,
  workflows, code clone, memory db, agents seed, scheduler ticker, …).
  Net behaviour preserved — only the symbol name changed.
- Validator throws migrated to `SafeError` where the message is
  deliberately user-facing: `validateSlugName`,
  `validateLanguages`, `updateProject`, `deleteProject`,
  `validateProjectUiPrefsPatch`, `restoreVersion` (versioning),
  `safeWorkspacePath` + `assertNotProtected`,
  `validateCron` + `validateAgent` in web_news routes.
- `src/server/scripts_routes.ts` and `src/server/versions_routes.ts`
  message-introspection catches (`UNIQUE constraint` / `not found` /
  `oversized`) switched to inspect `errorDetails(e)` but respond with
  `errorMessage(e)` — pattern matching keeps working, the wire format
  stays safe.
- `errorStatus(e, fallback)` + `logUnexpectedError(ctx.queue, e,
  context)` wired into the route catches we touched
  (`versions_routes.ts` restore, `web_news_routes.ts` create/update,
  `scripts_routes.ts` create/update). The SafeError `httpStatus` now
  flows through end-to-end — covered by an integration assertion that a
  404-bearing `SafeError` lands as status 404.
- Unit coverage: `tests/util/error.test.ts` (20 cases).
- Integration coverage: `tests/server/safe_error_response.test.ts`
  proves a `SafeError`-throwing validator surfaces its message, a
  `SafeError` with `httpStatus: 404` lands at status 404, and a plain
  `Error` is replaced by `INTERNAL_ERROR_MESSAGE`.

## Deferred

- Remaining `throw new Error(...)` user-facing validators in
  `src/memory/planning_*.ts`, `src/memory/kb_definitions.ts`,
  `src/memory/web_news.ts`, etc. The masking covers them already — they
  return `"Internal error"` to the user instead of their human-friendly
  message. Convert to `SafeError` as the modules are touched for other
  reasons; not worth a dedicated sweep.
- The remaining ~140 route catch blocks across `src/server/**` still use
  a literal `400`/`500` status and don't call `logUnexpectedError`. The
  response body is already safe (the new `errorMessage` masks any plain
  `Error`); only the status code mapping and the diagnostic queue-log
  trail are missing. Mechanical follow-up — swap `, 400)` →
  `, errorStatus(e, 400))` and add one `logUnexpectedError(...)` call
  per catch. Left for a follow-up sweep.

## Next step

1. Push to `main`; let CodeQL re-scan and confirm alert #13 closes.
2. Then update `docs/dev/follow-ups/code-scanning-alerts.md` to drop
   alert #13.

## Related files or docs

- `src/util/error.ts`
- `src/server/*_routes.ts`
- `src/memory/slug.ts`, `src/memory/projects.ts`,
  `src/memory/versioning.ts`, `src/memory/workspace_fs.ts`,
  `src/memory/user_project_prefs.ts`
- `tests/util/error.test.ts`
- `tests/server/safe_error_response.test.ts`
- `docs/dev/follow-ups/code-scanning-alerts.md`

## Status

needs-testing
