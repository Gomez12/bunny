# Testing

Test conventions, levels, and recipes for Bunny. Tests live under `tests/` at the repository root.

Test levels per [`AGENTS.md`](../../../AGENTS.md):

- **Unit** — pure functions and small modules
- **Integration** — multi-module flows, real SQLite, real queue
- **Component** — React components in `web/src/`
- **End-to-end** — full user flows
- **Regression** — every reported bug gets a failing test before the fix
- **Accessibility** — keyboard nav, focus, ARIA
- **i18n** — fallback behavior and missing-key detection
- **Error tests** — every expected production error path

Run:

```sh
bun test                                 # full suite
bun test tests/agent/render.test.ts      # single file
bun test -t "closes reasoning block"     # single test by name
bun test --watch
```

Test naming: English only. Sentence-form `it(...)` descriptions.
