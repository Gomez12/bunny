# Follow-up: Resolve GitHub code scanning alerts

## What remains

CodeQL (GitHub code scanning) currently reports 12 open alerts on `main`:

| # | Rule | Path / line |
| --- | --- | --- |
| 21 | `js/incomplete-sanitization` | `src/planning/report.ts:709` |
| 20 | `js/xss-through-dom` | `web/src/components/news/FeedDialog.tsx:266` |
| 19 | `js/xss-through-dom` | `client/ui/setup.js:124` |
| 18 | `js/xss-through-dom` | `client/ui/setup.js:63` |
| 13 | `js/stack-trace-exposure` | `src/server/http.ts:13` (sink); ~50 sources in `src/server/*_routes.ts` flowing via `errorMessage()` |
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
   - `setup.js`: validate `url` is an `http(s)` URL before assigning to
     `window.location.href`.
   - `FeedDialog.tsx`: validate `feedUrl` is an `http(s)` URL before using as
     `href`.
   - HTML tag strippers in `web.ts`, `feed_parser.ts`, `handle_update.ts`:
     loop the regex to a fixed point, so nested/malformed tag sequences cannot
     leave a residue containing `<script` after a single pass.
   - `errorMessage()`: trim to first line, drop stack-frame fragments, cap
     length. This is defense-in-depth; CodeQL may still report `#13` until the
     `SafeError` refactor below lands.
2. Follow-up (separate task): introduce `class SafeError extends Error` and
   migrate `throw new Error("…validation…")` sites in `src/server/**` and
   `src/business/**` so `errorMessage()` can refuse to expose `Error.message`
   for non-`SafeError` instances.

## Related files or docs

- `src/util/error.ts`
- `src/server/http.ts`
- `src/planning/report.ts`
- `src/prompts/toml_utils.ts`
- `src/tools/web.ts`
- `src/web_news/feed_parser.ts`
- `src/telegram/handle_update.ts`
- `web/src/components/news/FeedDialog.tsx`
- `client/ui/setup.js`

## Status

in-progress
