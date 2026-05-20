# Follow-up: Resolve GitHub code scanning alerts

## What remains

CodeQL (GitHub code scanning) currently reports 12 open alerts on `main`:

| # | Rule | Path / line |
| --- | --- | --- |
| 21 | `js/incomplete-sanitization` | `src/planning/report.ts:709` |
| 20 | `js/xss-through-dom` | `web/src/components/news/FeedDialog.tsx:266` |
| 19 | `js/xss-through-dom` | ~~`client/ui/setup.js:124`~~ — resolved when the Tauri client (`client/`) was removed (2026-05-20) |
| 18 | `js/xss-through-dom` | ~~`client/ui/setup.js:63`~~ — resolved when the Tauri client (`client/`) was removed (2026-05-20) |
| 13 | `js/stack-trace-exposure` | `src/server/http.ts:13` (sink); ~50 sources in `src/server/*_routes.ts` flowing via `errorMessage()` — barrier landed via `SafeError` (2026-05-20), waiting on CodeQL re-scan |
| 12 | `js/incomplete-sanitization` | `src/prompts/toml_utils.ts:17` |
| 10 | `js/incomplete-multi-character-sanitization` | `src/web_news/feed_parser.ts:75` |
| 9 | `js/incomplete-multi-character-sanitization` | `src/tools/web.ts:276` |
| 8 | `js/incomplete-multi-character-sanitization` | `src/tools/web.ts:272` |
| 7 | `js/incomplete-multi-character-sanitization` | `src/tools/web.ts:272` |
| 6 | `js/incomplete-multi-character-sanitization` | `src/tools/web.ts:210` |
| 5 | `js/incomplete-multi-character-sanitization` | `src/tools/web.ts:205` |
| 4 | `js/incomplete-multi-character-sanitization` | `src/telegram/handle_update.ts:499` |

## Why not done now

Tracked here so the fix lands in one focused PR rather than being scattered.
Alert #13 in particular has ~50 source positions across `src/server/*_routes.ts`
which all flow through `errorMessage()` in `src/util/error.ts`; fully eliminating
the rule will likely require a dedicated `SafeError`/`BunnyError` class so the
server can distinguish user-safe messages from arbitrary `Error.message`
values.

## Next step

1. Quick fixes (this task):
   - `toml_utils.ts` / `report.ts`: escape backslashes before other meta-chars.
   - `FeedDialog.tsx`: validate `feedUrl` is an `http(s)` URL before using as
     `href`.
   - HTML tag strippers in `web.ts`, `feed_parser.ts`, `handle_update.ts`:
     loop the regex to a fixed point, so nested/malformed tag sequences cannot
     leave a residue containing `<script` after a single pass.
   - `errorMessage()`: trim to first line, drop stack-frame fragments, cap
     length. This is defense-in-depth; CodeQL may still report `#13` until the
     `SafeError` refactor below lands.
2. Follow-up (separate task, landed 2026-05-20): introduced
   `class SafeError extends Error` and split `errorMessage()` (response-safe,
   masks non-`SafeError` to `INTERNAL_ERROR_MESSAGE`) from `errorDetails()`
   (diagnostic, unchanged old behaviour). Migrated ~45 diagnostic call sites
   from `errorMessage` to `errorDetails` and converted the high-traffic
   validators (`validateSlugName`, `validateLanguages`,
   `safeWorkspacePath`, `restoreVersion`, web-news `validateCron` /
   `validateAgent`, `updateProject`/`deleteProject`,
   `validateProjectUiPrefsPatch`) to `SafeError`. See
   `docs/dev/follow-ups/safe-error-class.md`. Alert #13 is expected to close
   on the next CodeQL scan.

## Related files or docs

- `src/util/error.ts`
- `src/server/http.ts`
- `src/planning/report.ts`
- `src/prompts/toml_utils.ts`
- `src/tools/web.ts`
- `src/web_news/feed_parser.ts`
- `src/telegram/handle_update.ts`
- `web/src/components/news/FeedDialog.tsx`

## Status

in-progress
