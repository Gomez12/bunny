# HTTP API

Bunny exposes a plain, framework-free HTTP API on the same port as the web UI
(`bun run serve` or the compiled binary, default `:3000`). Routes are
dispatched by [`handleApi` in `src/server/routes.ts`](../src/server/routes.ts)
with a switch on `pathname`; each domain module owns a `handle<Domain>Route`
returning either a `Response` (matched) or `undefined` (pass through).

Mount order matters: domain routes are evaluated before the generic project
routes, so `/api/projects/:p/board` hits the board router rather than
returning 404 from the generic project handler.

## Authentication

Handled by [`authenticate` in `src/server/auth_middleware.ts`](../src/server/auth_middleware.ts):

1. `Authorization: Bearer bny_…` — API-key lookup (minted via the web UI).
2. `bunny_session=<token>` cookie — HTTP-only session set by `/api/auth/login`.
3. No match → `401 {"error":"unauthorized"}`.

Routes under `/api/auth/*`, `/api/users*`, `/api/apikeys*` are evaluated
before the auth check (see `handleAuthRoute` below). Every other endpoint
requires an authenticated user.

All browser calls use `credentials: "include"` so the cookie rides along.
API keys are preferred for CLI / scripts.

## Error shape

Non-2xx responses are JSON `{ "error": "<short code>" }`, optionally with
`details` or `message`. Common codes: `unauthorized` (401), `forbidden`
(403), `not_found` (404), `conflict` (409), `bad_request` (400).

## SSE streaming

A handful of endpoints stream Server-Sent Events. Event shapes are defined in
[`src/agent/sse_events.ts`](../src/agent/sse_events.ts) and shared with the
frontend. Use `fetch` with a body reader — not `EventSource` — because the
streaming endpoints are POSTs.

Chat-bound streams (`/api/chat`, `/api/messages/:id/regenerate`, plus the
edit/ask SSE flows) can emit two queue-state events when the upstream
concurrency gate (ADR 0035) makes the call wait:

- `llm_queue_wait { type, position, since }` — fires before the await.
  `position` is 1-based (1 = next-up); `since` is `Date.now()` when the
  wait started.
- `llm_queue_release { type, waitedMs }` — fires after the gate releases
  the call, just before the upstream `fetch()`. `waitedMs` is the wall-
  clock queue time. Pairs with the most recent `llm_queue_wait`.

The frontend uses these to show "In wachtrij (positie X)" and to pause the
elapsed-time counter while queued. Calls that slip in below the cap don't
emit either event — UIs only see queue state when there was an actual wait.

Streaming endpoints:

- `POST /api/chat`
- `POST /api/messages/:id/regenerate`
- `POST /api/whiteboards/:id/ask`
- `POST /api/documents/:id/ask`
- `POST /api/projects/:p/contacts/ask`
- `GET  /api/cards/:id/runs/:runId/stream`
- `POST /api/projects/:p/kb/definitions/:id/generate`
- `POST /api/projects/:p/kb/definitions/:id/generate-illustration`

Fire-and-forget endpoints return `202 Accepted` with a handle:

- `POST /api/cards/:id/run`
- `POST /api/tasks/:id/run-now`
- `POST /api/projects/:p/news/topics/:id/run-now`

---

## Auth, users, API keys

Source: [`src/server/auth_routes.ts`](../src/server/auth_routes.ts).

| Method | Path                        | Auth          | Notes                                                                                                       |
| ------ | --------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------- |
| POST   | `/api/auth/login`           | public        | Body `{ username, password }`. Sets the `bunny_session` cookie, returns the `User` DTO.                     |
| POST   | `/api/auth/logout`          | authenticated | Revokes the current session, clears the cookie.                                                             |
| GET    | `/api/auth/me`              | authenticated | Returns the current `User`; used for the web boot check.                                                    |
| POST   | `/api/auth/password`        | authenticated | Body `{ currentPassword?, newPassword }`. `currentPassword` is skipped only when `mustChangePassword` is set. |
| GET    | `/api/users/me`             | authenticated | Alias for `/api/auth/me`.                                                                                   |
| PATCH  | `/api/users/me`             | authenticated | Body supports `displayName`, `email`, `expandThinkBubbles`, `expandToolBubbles`, `preferredLanguage`.        |
| GET    | `/api/users/directory`      | authenticated | Lightweight `{id, username, displayName}` list for @-mention autocomplete. Query `q`, capped at 200.        |
| GET    | `/api/users`                | admin         | Paginated user list. Query `q`, `limit` (default 50), `offset`.                                             |
| POST   | `/api/users`                | admin         | Body `{ username, password, role?, displayName?, email? }`. Forces `mustChangePassword = true`.             |
| GET    | `/api/users/:id`            | admin         | Full user record.                                                                                           |
| PATCH  | `/api/users/:id`            | admin         | Body `{ role?, displayName?, email? }`.                                                                     |
| DELETE | `/api/users/:id`            | admin         | Rejects self-delete.                                                                                        |
| POST   | `/api/users/:id/password`   | admin         | Admin reset. Sets `mustChangePassword = true`, revokes all sessions.                                        |
| GET    | `/api/apikeys`              | authenticated | Own API keys (metadata only — the secret is returned once at creation).                                     |
| POST   | `/api/apikeys`              | authenticated | Body `{ name, ttlDays? | expiresAt? }`. Returns `{ key, meta }`; the `key` is not stored, only its hash.    |
| DELETE | `/api/apikeys/:id`          | authenticated | Revokes a key you own (admins can revoke any).                                                              |

---

## Sessions, messages, chat

Source: [`src/server/routes.ts`](../src/server/routes.ts) + [`src/server/chat_routes.ts`](../src/server/chat_routes.ts).

| Method | Path                                    | Auth                | Notes                                                                                                                                                           |
| ------ | --------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/sessions`                         | authenticated       | Query `q`, `project`, `scope` (`mine`\|`all`, admins only for `all`), `excludeHidden`. Non-admins are always forced to `scope=mine`.                             |
| POST   | `/api/sessions`                         | authenticated       | Returns a fresh session id (client-generated UUID; no DB row is written until the first message).                                                               |
| PATCH  | `/api/sessions/:id`                     | owner / admin       | Body `{ hiddenFromChat }` — per-user visibility flag in `session_visibility`.                                                                                   |
| PATCH  | `/api/sessions/:id/quick-chat`          | owner / admin       | Body `{ isQuickChat }` — toggles the auto-hide-after-idle Quick Chat flag for the caller.                                                                        |
| POST   | `/api/sessions/:id/fork`                | viewer              | Body `{ untilMessageId?, asQuickChat?, project?, editLastMessageContent? }` — clones the non-trimmed history into a new session.                                 |
| GET    | `/api/sessions/:id/messages`            | owner / admin       | Full message list for a session (content + reasoning + tool_result rows). Optional `?limit=<n>&before_id=<id>` cursor: with `limit` returns the latest `n` rows ascending; combine with `before_id` to page backwards. Hard-capped at 5000.                              |
| PATCH  | `/api/messages/:id`                     | owner / admin       | Body `{ content }` — edits a user or assistant message in place.                                                                                                |
| POST   | `/api/messages/:id/trim-after`          | owner / admin       | Deletes every message after the referenced one.                                                                                                                 |
| POST   | `/api/messages/:id/regenerate`          | owner / admin       | **SSE.** Regenerates an answer; chains via `messages.regen_of_message_id` so the UI can offer `< n/m >` navigation.                                             |
| POST   | `/api/chat`                             | authenticated       | **SSE.** Body `{ sessionId?, prompt, project?, agent?, attachments? }`. `agent` may also be a leading `@mention` in `prompt`. Response headers echo `X-Session-Id`, `X-Project`, `X-Agent`. |

Attachment shape: `{ kind: "image", mime: "image/*", dataUrl: "data:…;base64,…" }`.
Maximum 4 images per turn, 10 MB per image.

---

## Projects

Source: [`src/server/routes.ts`](../src/server/routes.ts).

| Method | Path                           | Auth                  | Notes                                                                                                     |
| ------ | ------------------------------ | --------------------- | --------------------------------------------------------------------------------------------------------- |
| GET    | `/api/projects`                | authenticated         | Lists projects the caller can see (public + own private).                                                 |
| POST   | `/api/projects`                | authenticated         | Body `{ name, description?, visibility?, languages?, defaultLanguage?, systemPrompt?, appendMode?, lastN?, recallK? }`. Creates the project row and `$BUNNY_HOME/projects/<name>/`. |
| GET    | `/api/projects/:name`          | viewer (see + own)    | Single project DTO.                                                                                       |
| PATCH  | `/api/projects/:name`          | owner / admin         | Partial update; name is immutable (primary key + directory path).                                          |
| DELETE | `/api/projects/:name`          | owner / admin         | Cascades via `ON DELETE CASCADE`; workspace dir is *not* removed automatically.                            |

---

## Agents & tools catalogue

Source: [`src/server/agent_routes.ts`](../src/server/agent_routes.ts).

| Method | Path                                         | Auth                  | Notes                                                                         |
| ------ | -------------------------------------------- | --------------------- | ----------------------------------------------------------------------------- |
| GET    | `/api/tools`                                 | authenticated         | Tool names available for agent whitelists (excludes `call_agent`, which is implicit). |
| GET    | `/api/agents`                                | authenticated         | Agents the caller can see.                                                    |
| POST   | `/api/agents`                                | authenticated         | Body `{ name, description?, visibility?, isSubagent?, knowsOtherAgents?, contextScope?, systemPrompt?, appendMode?, tools?, allowedSubagents?, lastN?, recallK? }`. Auto-links to the default project. |
| GET    | `/api/agents/:name`                          | viewer                | Full agent definition incl. linked projects.                                  |
| PATCH  | `/api/agents/:name`                          | owner / admin         | Partial update.                                                               |
| DELETE | `/api/agents/:name`                          | owner / admin         |                                                                              |
| GET    | `/api/projects/:p/agents`                    | project viewer        | Agents linked to the project.                                                 |
| POST   | `/api/projects/:p/agents`                    | project owner / admin | Body `{ agent }` — links an existing agent to the project.                    |
| DELETE | `/api/projects/:p/agents/:agent`             | project owner / admin | Unlinks.                                                                      |

---

## Skills

Source: [`src/server/skill_routes.ts`](../src/server/skill_routes.ts).

| Method | Path                                     | Auth                  | Notes                                                                  |
| ------ | ---------------------------------------- | --------------------- | ---------------------------------------------------------------------- |
| GET    | `/api/skills`                            | authenticated         | Visible skills.                                                        |
| POST   | `/api/skills`                            | authenticated         | Body `{ name, description?, visibility?, skillMd }`. Writes `SKILL.md` on disk. |
| POST   | `/api/skills/install`                    | authenticated         | Body `{ url }` — GitHub tree / blob URL or `skills.sh` identifier; fetches and unpacks. |
| GET    | `/api/skills/:name`                      | viewer                |                                                                        |
| PATCH  | `/api/skills/:name`                      | owner / admin         | Body `{ description?, visibility?, skillMd? }`.                        |
| DELETE | `/api/skills/:name`                      | owner / admin         |                                                                        |
| GET    | `/api/projects/:p/skills`                | project viewer        | Skills linked to the project.                                          |
| POST   | `/api/projects/:p/skills`                | project owner / admin | Body `{ skill }`.                                                       |
| DELETE | `/api/projects/:p/skills/:skill`         | project owner / admin |                                                                        |

---

## Boards (kanban)

Source: [`src/server/board_routes.ts`](../src/server/board_routes.ts). Board
routes are mounted before the generic project routes.

| Method | Path                                          | Auth                   | Notes                                                                                                  |
| ------ | --------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------ |
| GET    | `/api/projects/:p/board`                      | project viewer         | Returns `{ project, swimlanes, cards }`; idempotently seeds `Todo/Doing/Done` for legacy projects.     |
| POST   | `/api/projects/:p/swimlanes`                  | project owner / admin  | Body `{ name, wipLimit?, autoRun?, defaultAssigneeUserId?, defaultAssigneeAgent?, nextSwimlaneId?, color?, group? }`. |
| PATCH  | `/api/swimlanes/:id`                          | project owner / admin  | Partial update.                                                                                        |
| DELETE | `/api/swimlanes/:id`                          | project owner / admin  |                                                                                                        |
| POST   | `/api/projects/:p/cards`                      | project viewer         | Body `{ title, description?, swimlaneId, estimateHours?, assigneeUserId?, assigneeAgent?, autoRun? }`. Assignee is **mutually exclusive**. |
| GET    | `/api/cards/:id`                              | project viewer         | Includes `latestRunStatus`.                                                                            |
| PATCH  | `/api/cards/:id`                              | `canEditCard`          | Partial update.                                                                                        |
| DELETE | `/api/cards/:id`                              | `canEditCard`          | Soft-archive (`archivedAt`).                                                                           |
| POST   | `/api/cards/:id/move`                         | `canEditCard`          | Body `{ swimlaneId }`; uses sparse positions with midpoint arithmetic.                                 |
| GET    | `/api/cards/:id/runs`                         | project viewer         | Historical runs.                                                                                       |
| POST   | `/api/cards/:id/run`                          | `canEditCard`          | **202 + detached.** Returns `{ runId, sessionId }`; the run streams on the URL below.                  |
| GET    | `/api/cards/:id/runs/:runId/stream`           | project viewer         | **SSE.** Replays the in-memory fanout; after the 60 s grace window falls back to `/api/sessions/:id/messages`. |

`canEditCard` = admin, project owner, card creator, or user-assignee.

---

## Whiteboards

Source: [`src/server/whiteboard_routes.ts`](../src/server/whiteboard_routes.ts).

| Method | Path                                 | Auth                  | Notes                                                                  |
| ------ | ------------------------------------ | --------------------- | ---------------------------------------------------------------------- |
| GET    | `/api/projects/:p/whiteboards`       | project viewer        |                                                                        |
| POST   | `/api/projects/:p/whiteboards`       | project owner / admin | Body `{ title }`.                                                       |
| GET    | `/api/whiteboards/:id`               | project viewer        | Excalidraw JSON + metadata + thumbnail.                                 |
| PATCH  | `/api/whiteboards/:id`               | `canEditWhiteboard`   | Body `{ title?, elements?, thumbnail? }`.                               |
| DELETE | `/api/whiteboards/:id`               | `canEditWhiteboard`   | **Soft-delete** — see the Trash section below.                          |
| POST   | `/api/whiteboards/:id/edit`          | `canEditWhiteboard`   | LLM edit mode — modifies elements via `runAgent`. Session is hidden from chat. |
| POST   | `/api/whiteboards/:id/ask`           | project viewer        | **SSE.** Starts a hidden chat session with the whiteboard PNG attached and returns `{ sessionId }`. |

---

## Documents

Source: [`src/server/document_routes.ts`](../src/server/document_routes.ts).

| Method | Path                                       | Auth                  | Notes                                                                                                   |
| ------ | ------------------------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------- |
| GET    | `/api/projects/:p/documents`               | project viewer        |                                                                                                         |
| POST   | `/api/projects/:p/documents`               | project owner / admin | Body `{ name, contentMd? }`.                                                                            |
| GET    | `/api/documents/:id`                       | project viewer        | Returns markdown + metadata + thumbnail.                                                                 |
| PATCH  | `/api/documents/:id`                       | `canEditDocument`     | Body `{ name?, contentMd? }`.                                                                            |
| DELETE | `/api/documents/:id`                       | `canEditDocument`     | **Soft-delete** — see the Trash section below.                                                          |
| POST   | `/api/documents/:id/edit`                  | `canEditDocument`     | LLM edit via `runAgent`.                                                                                 |
| POST   | `/api/documents/:id/ask`                   | project viewer        | **SSE.** Opens a hidden chat session seeded with the doc content.                                        |
| POST   | `/api/documents/:id/export/docx`           | project viewer        | Returns a binary Word doc (server-side `docx` package).                                                  |
| POST   | `/api/documents/:id/export/html`           | project viewer        | Returns an HTML zip (server-side `jszip`).                                                               |
| POST   | `/api/documents/:id/save-as-template`      | `canEditDocument`     | Stores a reusable template.                                                                              |
| POST   | `/api/documents/:id/images`                | `canEditDocument`     | Multipart upload; stored under `workspace/documents/<docId>/images/`.                                    |

---

## Contacts

Source: [`src/server/contact_routes.ts`](../src/server/contact_routes.ts).

| Method | Path                                                        | Auth                  | Notes                                                     |
| ------ | ----------------------------------------------------------- | --------------------- | --------------------------------------------------------- |
| GET    | `/api/projects/:p/contact-groups`                           | project viewer        |                                                           |
| POST   | `/api/projects/:p/contact-groups`                           | project owner / admin | Body `{ name, color? }`.                                  |
| PATCH  | `/api/contact-groups/:id`                                   | project owner / admin |                                                           |
| DELETE | `/api/contact-groups/:id`                                   | project owner / admin |                                                           |
| GET    | `/api/projects/:p/contacts`                                 | project viewer        | Query `q`, `groupId`, `limit`, `offset`.                   |
| POST   | `/api/projects/:p/contacts`                                 | project owner / admin | Body fields mirror the vCard schema.                       |
| POST   | `/api/projects/:p/contacts/import`                          | project owner / admin | Multipart: `.vcf` file or JSON payload of parsed contacts. |
| POST   | `/api/projects/:p/contacts/export`                          | project viewer        | Returns a single `.vcf` for the provided id list.           |
| POST   | `/api/projects/:p/contacts/ask`                             | project viewer        | **SSE.** Hidden chat with contact summary injected.         |
| POST   | `/api/projects/:p/contacts/edit`                            | project owner / admin | LLM-driven analysis / reorganisation.                       |
| GET    | `/api/projects/:p/contacts/:id/vcf`                         | project viewer        | Single-contact vCard download.                              |
| PATCH  | `/api/contacts/:id`                                         | project owner / admin |                                                           |
| DELETE | `/api/contacts/:id`                                         | project owner / admin | **Soft-delete** — see the Trash section below.             |

---

## Knowledge Base (definitions)

Source: [`src/server/kb_routes.ts`](../src/server/kb_routes.ts).

| Method | Path                                                         | Auth                  | Notes                                                                                         |
| ------ | ------------------------------------------------------------ | --------------------- | --------------------------------------------------------------------------------------------- |
| GET    | `/api/projects/:p/kb/definitions`                            | project viewer        |                                                                                               |
| POST   | `/api/projects/:p/kb/definitions`                            | project owner / admin | Body `{ term, manualDescription?, isProjectDependent? }`.                                      |
| GET    | `/api/projects/:p/kb/definitions/:id`                        | project viewer        |                                                                                               |
| PATCH  | `/api/projects/:p/kb/definitions/:id`                        | `canEditDefinition`   | Body may update the source fields; staleness of translation sidecars is marked automatically.   |
| DELETE | `/api/projects/:p/kb/definitions/:id`                        | `canEditDefinition`   | **Soft-delete** — see the Trash section below.                                                 |
| POST   | `/api/projects/:p/kb/definitions/:id/generate`               | `canEditDefinition`   | **SSE.** LLM short/long + sources generation; 409 when a generation is already in flight.       |
| POST   | `/api/projects/:p/kb/definitions/:id/clear-llm`              | `canEditDefinition`   | Clears LLM output (short/long/sources), sets `llm_cleared = 1`.                                |
| POST   | `/api/projects/:p/kb/definitions/:id/generate-illustration`  | `canEditDefinition`   | **SSE.** Produces an SVG illustration (capped 200 KB).                                          |
| POST   | `/api/projects/:p/kb/definitions/:id/clear-illustration`     | `canEditDefinition`   | Wipes the stored SVG.                                                                          |
| POST   | `/api/projects/:p/kb/definitions/:id/active`                 | `canEditDefinition`   | Body `{ active }` — flips which description (`manual` / `short` / `long`) is the live one.     |

---

## Web News

Source: [`src/server/web_news_routes.ts`](../src/server/web_news_routes.ts).

| Method | Path                                                       | Auth                  | Notes                                                                                         |
| ------ | ---------------------------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------- |
| GET    | `/api/projects/:p/news/topics`                             | project viewer        |                                                                                               |
| POST   | `/api/projects/:p/news/topics`                             | project owner / admin | Body `{ name, agent, terms?, updateCron, renewTermsCron?, alwaysRegenerateTerms? }`.          |
| GET    | `/api/projects/:p/news/topics/:id`                         | project viewer        |                                                                                               |
| PATCH  | `/api/projects/:p/news/topics/:id`                         | project owner / admin |                                                                                               |
| DELETE | `/api/projects/:p/news/topics/:id`                         | project owner / admin |                                                                                               |
| POST   | `/api/projects/:p/news/topics/:id/run-now`                 | project owner / admin | **202 + detached.** Forces an immediate aggregation run.                                       |
| POST   | `/api/projects/:p/news/topics/:id/regenerate-terms`        | project owner / admin | Sets `next_renew_terms_at = 0` so the next tick renews terms before fetching.                  |
| GET    | `/api/projects/:p/news/items`                              | project viewer        | Query `topicId`, `limit`, `offset`.                                                            |
| DELETE | `/api/projects/:p/news/items/:id`                          | project owner / admin |                                                                                               |

---

## Workspace (files)

Source: [`src/server/workspace_routes.ts`](../src/server/workspace_routes.ts).

| Method | Path                                        | Auth             | Notes                                                                                                               |
| ------ | ------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/projects/:p/workspace/list?path=…`    | project viewer   | Directory listing.                                                                                                  |
| GET    | `/api/projects/:p/workspace/file?path=…`    | project viewer   | Query `encoding` = `utf8` (default) \| `base64` \| `raw`. `raw` returns the file as a binary download.               |
| POST   | `/api/projects/:p/workspace/file`           | project owner / admin | JSON `{ path, content, encoding? }` **or** `multipart/form-data` with `file[]`. 100 MB cap per file.                |
| POST   | `/api/projects/:p/workspace/mkdir`          | project owner / admin | Body `{ path }`.                                                                                                    |
| POST   | `/api/projects/:p/workspace/move`           | project owner / admin | Body `{ from, to }`. Refuses to move the protected `input/` and `output/` roots themselves.                         |
| DELETE | `/api/projects/:p/workspace?path=…`         | project owner / admin | Delete file / dir. Protected roots cannot be removed; their contents can.                                          |

All paths flow through `safeWorkspacePath` (no absolute paths, no `..`, no
symlink escapes).

---

## Translations (multi-language sidecars)

Source: [`src/server/translation_routes.ts`](../src/server/translation_routes.ts).
Dispatched via `TRANSLATABLE_REGISTRY`, supporting `kind ∈ {kb_definition,
document, contact, board_card}`.

| Method | Path                                                    | Auth             | Notes                                                                                                              |
| ------ | ------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------ |
| GET    | `/api/projects/:p/translations/:kind/:id`               | entity viewer    | Sidecar rows per language, each with `status`, `sourceHash`, `isOrphaned` (language no longer on the project).      |
| POST   | `/api/projects/:p/translations/:kind/:id/:lang`         | entity editor    | Flips the row to `pending` and kicks the scheduler (runs `translation.auto_translate_scan` immediately via `runTask`). |

---

## Scheduler (system + user tasks)

Source: [`src/server/scheduled_task_routes.ts`](../src/server/scheduled_task_routes.ts).

| Method | Path                             | Auth                                   | Notes                                                                                       |
| ------ | -------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------- |
| GET    | `/api/tasks/handlers`            | authenticated                          | List of registered handler names (e.g. `board.auto_run_scan`, `translation.auto_translate_scan`, `web_news.auto_run_scan`). |
| GET    | `/api/tasks`                     | authenticated                          | Non-admins see their own user-tasks; admins see system + user.                              |
| POST   | `/api/tasks`                     | system: admin / user: authenticated    | Body `{ kind, handler, cronExpr, payload?, enabled? }`. `kind = "system"` requires admin.   |
| GET    | `/api/tasks/:id`                 | visible-to-caller                      |                                                                                             |
| PATCH  | `/api/tasks/:id`                 | admin (system) / owner or admin (user) |                                                                                             |
| DELETE | `/api/tasks/:id`                 | admin (system) / owner or admin (user) |                                                                                             |
| POST   | `/api/tasks/:id/run-now`         | admin (system) / owner or admin (user) | **202 + detached.** Fires the handler outside the cron schedule.                            |

---

## Dashboard

Source: [`src/server/dashboard_routes.ts`](../src/server/dashboard_routes.ts).

| Method | Path                              | Auth          | Notes                                                                                             |
| ------ | --------------------------------- | ------------- | ------------------------------------------------------------------------------------------------- |
| GET    | `/api/dashboard?range=24h\|7d\|30d\|90d\|all` | authenticated | Stats payload: KPIs, time-series, tool/agent/project breakdowns, error rates, scheduler health, activity feed. Admins see global data; everyone else sees their own. |

---

## Trash (admin, cross-entity bin)

Source: [`src/server/trash_routes.ts`](../src/server/trash_routes.ts). Backs
ADR 0025. Four entity kinds participate: `document`, `whiteboard`, `contact`,
`kb_definition`. Soft-deletes originate from the per-entity DELETE routes
above; these endpoints manage the aftermath.

| Method | Path                                 | Auth  | Notes                                                                                                                           |
| ------ | ------------------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/trash`                         | admin | `{ items: TrashItem[] }` with every soft-deleted row across every kind, newest-first.                                           |
| POST   | `/api/trash/:kind/:id/restore`       | admin | Restores the row; strips the `__trash:<id>:` prefix. `409 { error: "name_conflict" }` when another live row now owns the name.  |
| DELETE | `/api/trash/:kind/:id`               | admin | Hard-deletes the row (cascades to translation sidecars). Refuses (`404 not_found`) when the target is still live.                |

`TrashItem` shape: `{ kind, id, name, project, deletedAt, deletedBy,
createdBy, createdAt }`. Queue logging uses `topic: "trash"` with kinds
`restore` / `hard_delete`. The individual entity delete endpoints now include
`soft: true` in their queue payload so the Logs tab can separate soft from
hard deletes.

---

## Events (audit log, admin)

Source: [`src/server/routes.ts`](../src/server/routes.ts).

| Method | Path                  | Auth  | Notes                                                                                                              |
| ------ | --------------------- | ----- | ------------------------------------------------------------------------------------------------------------------ |
| GET    | `/api/events`         | admin | Query `topic`, `kind`, `session_id`, `user_id`, `errors_only`, `from`, `to`, `q`, `limit`, `offset`. Paginated.   |
| GET    | `/api/events/facets`  | admin | Distinct values for `topic` / `kind` used by the filter UI.                                                        |

---

## Misc

| Method | Path                   | Auth          | Notes                                                                                         |
| ------ | ---------------------- | ------------- | --------------------------------------------------------------------------------------------- |
| GET    | `/api/config/ui`       | authenticated | Public subset of `bunny.config.toml` (`autosaveIntervalMs`).                                  |
| POST   | `/api/upload-image`    | authenticated | Multipart `file`. Converts the image to a base64 data URL. Allowed MIME: `image/{png,jpeg,gif,webp}`; 10 MB cap. Used as a fallback for Safari 26+. |

---

## Queue logging

Every HTTP **mutation** (`POST` / `PATCH` / `DELETE`, plus SSE starts) logs a
fire-and-forget event through the queue — `ctx.queue.log({ topic, kind,
userId, data })` — so the Logs tab and the dashboard reflect reality. See
[ADR 0004](./adr/0004-bunqueue-as-spine.md) for the topic naming convention
and [`CLAUDE.md`](../CLAUDE.md) for the enforcement rule.
