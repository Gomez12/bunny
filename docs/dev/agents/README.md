# How-to recipes

Short, concrete walkthroughs for the most common extension points. Each page follows the same shape:

1. **When you need this** — 1 sentence.
2. **Steps** — numbered, with concrete file edits.
3. **Validation** — how to test end-to-end.
4. **Related concepts / entities / UI pages**.

## Index

- [**add-a-tool**](./add-a-tool.md) — static (registry) vs dynamic / closure-bound tools.
- [**add-a-scheduled-handler**](./add-a-scheduled-handler.md) — `HandlerRegistry.register` + `ensureSystemTask`.
- [**add-a-translatable-entity**](./add-a-translatable-entity.md) — `registerKind` + sidecar table + `markAllStale` hooks.
- [**add-a-trashable-entity**](./add-a-trashable-entity.md) — `registerTrashable` + reseed-translations hook + query audit.
- [**add-an-http-route**](./add-an-http-route.md) — switch-based router, ctx types, auth gating, queue log.
- [**add-a-nav-tab**](./add-a-nav-tab.md) — sidebar entry + icons.ts + localStorage + legacy alias.
- [**add-a-ui-component**](./add-a-ui-component.md) — when to put under `components/` vs tab-local.
- [**add-a-tiptap-node**](./add-a-tiptap-node.md) — custom Tiptap nodes with markdown round-trip.
- [**add-a-provider**](./add-a-provider.md) — new LLM provider profile.
- [**write-a-test**](./write-a-test.md) — `bun:test` + temp DB + mirror layout.

If a recipe you expected isn't here, add it — keep the file short and concrete.
