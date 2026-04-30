# ADR 0026 — `ask_user` interactive question tool

Status: Accepted — 2026-04-19

## Context

So far every LLM turn in Bunny has been one-shot: the user types a prompt, the
agent loop answers (possibly after several tool calls), and the stream ends.
When a prompt was ambiguous the model had two unhappy choices:

1. Guess and hope — often wrong, wastes a turn.
2. Answer back in plain text with a question, wait for the user to reply as a
   fresh user turn — loses the tool-level structure, and the model has already
   "committed" an assistant message so the next turn treats the guess-free
   question as context.

Claude Code's plan-mode `AskUserQuestion` affordance solves this elegantly:
the model can pause mid-turn, hand the user a multiple-choice card, and the
user's selection is returned as a tool result. The agent loop picks up right
where it left off. We want the same primitive in the web UI.

## Decision

Introduce a single closure-bound tool `ask_user` with a blocking handler.

1. **Tool** (`src/tools/ask_user.ts`). Args: `question` (required),
   `options` (array of suggested answers, 0–24 items — see change log), `allow_custom` (default
   `true`), `multi_select` (default `false`). The handler generates a
   `questionId`, calls an `emit` callback (wired to the renderer), registers a
   pending promise in an in-memory map, and `await`s it. On resolve the
   answer is returned as a plain `ToolResult.output` string so the next LLM
   turn sees the user's answer just like any other tool result.

2. **Pending registry** (`src/agent/ask_user_registry.ts`). Module-level
   `Map<sessionId::questionId, { resolve, reject, timer }>`. Exports
   `waitForAnswer`, `answerPendingQuestion`, `cancelPendingQuestion`. Default
   timeout 15 minutes; `answerPendingQuestion` returns `false` when no waiter
   exists so the route can translate to 404.

3. **SSE event** `ask_user_question` (see `src/agent/sse_events.ts`). Carries
   `{ questionId, question, options, allowCustom, multiSelect, author? }`.
   The `Renderer` interface grows an optional `onAskUserQuestion` callback;
   `createSseRenderer` implements it, the CLI / `silentRenderer` leave it
   `undefined`.

4. **Opt-in gating.** `RunAgentOptions.askUserEnabled: boolean` (default
   `false`) controls whether the tool is spliced into the per-run registry.
   Only the two genuinely interactive endpoints flip it on:
   - `POST /api/chat` (`src/server/routes.ts:handleChat`)
   - `POST /api/messages/:id/regenerate`
     (`src/server/chat_routes.ts:handleRegenerate`)
   All other `runAgent` call-sites (whiteboard/document/KB/contact edit
   handlers, board card runs, translation scheduler, subagent calls) keep it
   off, so a model that speculatively calls `ask_user` in those contexts
   finds it unavailable instead of blocking for 15 minutes unanswered. The
   gate is an explicit flag rather than a renderer-capability probe so it
   cannot silently re-enable if a non-chat path starts reusing the SSE
   renderer in the future.

5. **Answer endpoint** `POST /api/sessions/:sessionId/questions/:questionId/
   answer` with `{ answer: string }` (mounted inside
   `src/server/chat_routes.ts` alongside the other session-scoped routes).
   Auth: must pass `canAccessSession`. 404 when nothing is pending (stale
   card). Queue log uses `topic: "chat"`, `kind: "ask_user.answer"`.

6. **Frontend.** `useSSEChat` stacks `ask_user_question` events onto
   `Turn.userQuestions`; `ChatTab` renders one `UserQuestionCard` per entry
   inside the assistant bubble, below the tool-call cards. The card exposes
   radio/checkbox selection, **inline-editable text per option** (so the
   user can tweak an option before submitting), and an optional free-form
   textarea. Submission POSTs the answer, then marks the card as answered
   (read-only) until the matching `tool_result` frame lands and the stream
   continues.

## Consequences

- **Persistence and reloads.** Pending waiters live in process memory. A
  server restart, or a user refresh that tears down the SSE body-reader,
  drops the waiter and the tool eventually times out. The `tool_call` row
  still exists in `messages` (no matching `tool_result`) so the history
  shows an orphaned question. Acceptable for v1; a future improvement is
  to persist pending questions and rehydrate them on reconnect.
- **Renderer interface surface.** `Renderer.onAskUserQuestion` is optional
  and purely advisory — the tool's gate is `askUserEnabled`, not the
  callback's presence. Other transports can still add the callback for
  their own reasons without accidentally enabling the tool.
- **Schema widening.** `JsonSchemaObject` in `src/llm/types.ts` relaxed to
  allow arbitrary per-property JSON-Schema fields (needed for `items` on the
  `options` array). Adapter/provider code already forwards schemas verbatim,
  so no runtime impact — the change is purely a type fix.
- **Timeout tuning** lives in one place (`DEFAULT_TIMEOUT_MS` in
  `ask_user_registry.ts`). If 15 minutes proves too long/short for a given
  project we can promote it to `bunny.config.toml` later.
- **Security.** The route is authenticated and gated by `canAccessSession`.
  Answers are length-capped (10 000 chars) and treated as opaque strings —
  no parsing, no interpolation into system prompts.

## Alternatives considered

- **Two-phase tool (emit + blocking get-answer).** Cleaner separation in
  theory, but doubles the tool count and the agent usually wants the answer
  synchronously anyway. A single blocking tool matches Claude Code's
  `AskUserQuestion` primitive, which is the known-good reference.
- **Store the pending question in the DB** instead of in memory. Would
  survive restarts but the blocking promise lives in-process regardless, so
  a new connection after a restart still can't resume the original run.
  Reserved for a later revision.

## Change log

- **2026-04-30** — Raised the option cap from 6 to 24 and added scrolling
  (`max-height: 320px; overflow-y: auto`) to `.askuser__options` so longer
  menus fit without pushing the composer off-screen. Also added a
  client-side "Pick multiple" toggle on `UserQuestionCard` so the user can
  override the LLM-supplied `multi_select` flag locally — useful when the
  realistic answer is a list (e.g. ordering several milkshakes from a menu)
  even though the model picked single-choice. Trade-off: the toggle lets
  users multi-pick on questions where the LLM intended a single answer
  (e.g. "pick a primary key column"); accepted because `ask_user` options
  are advisory anyway and a free-form answer was always available. The
  multi→single transition reduces `selected` to its first element so the
  radio invariant holds and answer composition stays sane. The tool
  description (`tools.ask_user.description`) and the system-prompt hint
  (`agent.ask_user_hint`) now mention the longer-menu and `multi_select`
  affordances; both fixtures regenerated.
