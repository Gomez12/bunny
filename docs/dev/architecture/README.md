# Concepts

Cross-cutting subsystems. One page per subsystem. Not user-facing entities (those live in [`../entities/`](../entities/)); not frontend surface (that's [`../ui/`](../ui/)).

Skim the list; jump into the matching page when you touch the subsystem.

## Index

- [**agent-loop**](./agent-loop.md) — `runAgent`, tool registry, the outer/inner loop, `MAX_TOOL_ITERATIONS`.
- [**streaming-and-renderers**](./streaming-and-renderers.md) — LLM adapter, SSE stream parser, `Renderer` interface. CLI, SSE, silent, collecting.
- [**memory-and-recall**](./memory-and-recall.md) — message channels, FTS5 + sqlite-vec, hybrid recall, `last_n` replay, `excludeIds`.
- [**queue-and-logging**](./queue-and-logging.md) — bunqueue, `events` table, the mutation-logging mandate.
- [**auth**](./auth.md) — users, sessions, API keys, middleware, scope helpers.
- [**projects-as-scope**](./projects-as-scope.md) — projects table + on-disk assets, `canSeeProject` / `canEditProject`, system-prompt composition.
- [**scheduler**](./scheduler.md) — `scheduled_tasks`, `HandlerRegistry`, ticker, `claimDueTasks`.
- [**translation-pipeline**](./translation-pipeline.md) — `TRANSLATABLE_REGISTRY`, sidecar tables, `source_version` vs `source_hash`, staleness.
- [**soft-delete-and-trash**](./soft-delete-and-trash.md) — `registerTrashable`, `__trash:` name-munging, restore semantics.
- [**notifications-and-fanout**](./notifications-and-fanout.md) — mention scanner, per-user fanout, SSE events, OS toast shim.
- [**telegram-integration**](./telegram-integration.md) — per-project bot, inbound poll/webhook, outbound hooks.
- [**memory-and-soul**](./memory-and-soul.md) — per-(user, project), per-(agent, project), and per-user soul; hourly refresh.
- [**response-envelopes**](./response-envelopes.md) — response-shape policy, `requireProjectAccess` helper, deferred reuse opportunities.

The shell that holds the frontend together (sidebar, tokens, icons, rabbit) is in [`../ui/shell-and-navigation.md`](../ui/shell-and-navigation.md) — it's a frontend concern, not a backend concept.
