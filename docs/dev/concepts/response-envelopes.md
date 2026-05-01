# Response envelopes & route helpers

## What this covers

How `/api/*` responses are shaped, what the canonical access-check helper is, and a list of follow-up reuse opportunities that have been **identified but deferred** so future work can pick them up without re-discovering them.

## Current state (descriptive)

Bunny's HTTP layer is framework-free — every handler builds its own `Response`. As a result, JSON shapes drifted over time. Three patterns coexist today:

1. **Bare DTOs** — `json({ documents: [...] })`, `json({ project, swimlanes, cards })`. Most read endpoints.
2. **`{ ok: true }` confirmations** — `json({ ok: true, unreadCount })`. Most mutations + one-off operations.
3. **`{ error: "..." }` failures** — every error-path. The `error` field is always a plain string.

Crucially, **failures are uniform** (`{ error: string }` with the right HTTP status). Successes are heterogeneous. That's the actual asymmetry.

## Forward policy (prescriptive, for **new** routes)

When you add a new route in `src/server/<domain>_routes.ts`:

- **Errors:** keep returning `json({ error: "<short message>" }, <status>)`. Don't invent new failure shapes.
- **Successes:** return a **named-payload object**, not a bare array or scalar.
  - List endpoints: `{ items: [...] }` or `{ <plural>: [...] }` (e.g. `{ documents }`, `{ swimlanes }`). Pick `items` for new generic endpoints.
  - Single-entity reads: `{ <singular>: {...} }` (e.g. `{ document }`, `{ swimlane }`).
  - Mutations with no body to return: `json({ ok: true })`.
- **Don't** wrap in a discriminated `{ success, data, error }` envelope — the gain doesn't pay for the migration of existing routes.
- **Don't** include the `ok: true` flag on success-with-data responses — the HTTP status code is the success signal.

This is consistent with what most existing routes already do, just stated explicitly so the next handler doesn't drift further.

## Canonical access-check helper

For routes that take an **untrusted** project name from a URL or request body, use `requireProjectAccess` from `src/server/route_helpers.ts`:

```ts
import { requireProjectAccess } from "./route_helpers.ts";

function handleListThing(ctx: ThingRouteCtx, user: User, rawProject: string): Response {
  const access = requireProjectAccess(ctx.db, user, rawProject, "view"); // or "edit"
  if (!access.ok) return access.response;
  const { project, p } = access;
  // …business logic…
}
```

It bundles `validateProjectName` (400) + `getProject` existence (404) + `canSeeProject`/`canEditProject` (403) into one call and returns either `{ok: true, project, p}` or `{ok: false, response}`.

**When NOT to use it:**

- The project comes from an entity row already loaded (e.g. `card.project`, `doc.project`). Just call `canSeeProject(p, user)` / `canEditProject(p, user)` directly — the helper's savings are negligible there.
- The handler needs to branch read vs. write based on method/action *after* resolving the project (see `src/server/workspace_routes.ts:46-70`). The helper assumes you know the mode up-front.
- The route file already has its own `resolveProject`-style helper that wraps additional context (e.g. `src/server/kb_routes.ts:142-160`, `src/server/web_news_routes.ts:130-141`). Don't migrate those en masse; the file-local version is fine.

`canSeeProject` / `canEditProject` themselves now live in `route_helpers.ts` and are re-exported from `routes.ts` for backwards compatibility. Prefer importing them from `./route_helpers.ts` directly in new code.

## Deferred reuse opportunities

These were surfaced in a 2026-04-30 audit (`/Users/christiaansiebeling/.claude/plans/eager-twirling-toucan.md`). Each is real but skipped because the cost outweighed the gain in the current state. Record kept here so the next refactor doesn't re-discover them.

### R2 — Fanout/runner template

**Problem.** Four subsystems implement the same detached-runner-with-fanout pattern, each ~400-1500 LOC:

- `src/board/run_card.ts` — `runCard` + `getRunFanout` + `subscribeToRun`
- `src/web_news/run_topic.ts` — `runTopic` + topic-keyed fanout
- `src/workflows/run_workflow.ts` — `runWorkflow` + run-keyed fanout
- `src/code/graph/run.ts` — `runGraph` + `graphFanouts`

All share: detached `runAgent` (or job) call → in-memory `Map<id, Fanout>` → 60s post-close TTL → SSE `subscribe`/`replay` route.

**Why deferred.** The four are critical paths with different framing semantics (board uses the agent's tool whitelist; web_news preserves the agent prompt; workflow has node-stepping; graph is non-`runAgent`). A unifying base class would either be too rigid or too thin to be worth the churn. **Pre-condition for picking this up:** test coverage on each runner's edge cases (lost-race, timeout, late subscriber, drop-after-TTL). See `src/agent/run_fanout.ts` for the existing primitive — `createFanout` and `subscribeFanout` already handle the fanout half; only the runner-orchestration glue is duplicated.

### R4 — Web TabShell primitive

**Problem.** `web/src/tabs/{Chat,Document,Contacts,KnowledgeBase}Tab.tsx` each open with a list+sidebar+editor+chat shell. Each one is 500-700 LOC with 18-24 hooks. The four shells are *similar* but not *identical* — the sidebar in `ChatTab` shows the admin "Mine / All" toggle; the sidebar in `DocumentsTab` exposes the templates filter; the editor pane in `WhiteboardsTab` is Excalidraw rather than Tiptap.

**Why deferred.** A `TabShell` primitive would only be useful if it's flexible enough to host the variations, at which point the variations shape its API. Better to wait for a fifth tab to land that needs the same shell — at five copies the abstraction shape becomes obvious. For now: keep new tabs ~500 LOC and resist the urge to share state between them.

### R5 — Oversized files

Recorded sizes (2026-04-30):

- `src/workflows/run_workflow.ts` — **1438 LOC**. Mixes `runAgent` invocation, bash exec, loop-iteration, interactive gates, node-step buffering. **Splitting candidate:** `exec.ts` / `loop.ts` / `bash.ts` / `interactive.ts` modules underneath. Pre-condition: bundle of integration tests covering the loop+interactive interaction path.
- `src/server/routes.ts` — **911 LOC**. Central dispatcher; mixing route-matching, auth, project CRUD, sessions. **Already partially mitigated** by extracting per-domain `*_routes.ts` modules. The remaining bulk is project + session + event + memory routes. No split planned.
- `src/prompts/registry.ts` — **796 LOC**. 25 entries × ~30 LOC default-text strings. The size is intrinsic; splitting would just spread it. Skip.
- `src/server/{board,code,kb,document}_routes.ts` — **600-810 LOC** each. Each contains 10+ handler functions. **Splitting candidate by operation** (CRUD vs run/execute) — but the per-file `resolveProject` style (kb / web_news / telegram) keeps neighbours close together. Skip until one breaks 1000 LOC.

### E5 — Web bundle code-splitting per route

**Problem.** `web/dist/` is ~2 MB minified. Heavy dependencies that aren't always loaded: `@excalidraw/excalidraw`, `mermaid`, `@xyflow/react`, the full `@tiptap/*` ecosystem, `recharts`. They're pulled in at app boot regardless of which tab the user opens.

**Why deferred.** The Vite build doesn't currently split per-route; introducing `manualChunks` requires measuring per-tab dependency graphs first. **Pre-condition:** a real performance pain (cold-load metric > 3s on the target hardware), not just the size. The portable-binary embeds the bundle as a static blob, so wire-cost is paid once at HTTP first-load — the bundle isn't shipped over the wire repeatedly. **Cheaper alternative to try first:** lazy-import the heavy editors via `React.lazy`/`Suspense` (Excalidraw, Tiptap, Mermaid, xyflow) so a chat-only user never instantiates them.

## Related

- [`../how-to/add-an-http-route.md`](../how-to/add-an-http-route.md)
- [`../concepts/queue-and-logging.md`](./queue-and-logging.md) — every mutation logs.
- [`../concepts/auth.md`](./auth.md) — `authenticate` middleware + `canSeeProject` semantics.
- [ADR 0006 — Web UI](../../adr/0006-web-ui.md) — why `Bun.serve` + plain `switch` over a framework.
