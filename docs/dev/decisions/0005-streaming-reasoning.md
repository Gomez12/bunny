# ADR 0005 — Streaming and reasoning normalisation

**Status:** Accepted
**Date:** 2026-04-14

## Context

Reasoning-capable LLMs (OpenAI o1/o3, DeepSeek-R1, Anthropic Claude with extended thinking) return their "thought process" via a separate field in the streaming response. This field differs per provider:

| Provider | Field |
|----------|------|
| OpenAI o1/o3 | `choices[n].delta.reasoning_content` |
| DeepSeek | `choices[n].delta.reasoning_content` |
| OpenRouter | pass-through (depends on the underlying model) |
| Anthropic-compat (via LiteLLM etc.) | `choices[n].delta.thinking` + signature roundtrip |

The CLI must show reasoning in a distinguishable colour while keeping it out of the recall index.

## Decision

1. **Streaming-first adapter**: `adapter.chat()` always returns `AsyncIterable<StreamDelta>`. Each delta has a `channel: "content" | "reasoning" | "tool_call" | "usage"`.
2. **Provider profiles** (`src/llm/profiles.ts`): normalise all reasoning fields to `channel: "reasoning"`.
3. **CLI renderer** (`src/agent/render.ts`): maps channels to ANSI colours. Reasoning = dim italic inside a collapsible "╭─ thinking ─╮" block that closes as soon as content begins.
4. **Persistence**: reasoning is stored as a separate row (`messages.channel = 'reasoning'`). Not indexed in FTS5/vector unless `[memory].index_reasoning = true`.
5. **Roundtrip rule**: reasoning is NOT fed back into the LLM on follow-up turns (except Anthropic-compat thinking-blocks with signature — the provider profile decides).
6. **TTY detection**: ANSI codes only in a TTY context. In pipes/CI: reasoning lines prefixed with `[thinking]` or omitted via `--hide-reasoning` / `render.reasoning = "hidden"`.

## Consequences

- The `render.reasoning` setting (`"collapsed" | "inline" | "hidden"`) must be passed to the renderer. Default is `"collapsed"`.
- For Anthropic-compat providers with thinking blocks: `ChatMessage.provider_sig` must be sent along on the next request. This is not yet implemented in phase 1 (the agent loop stores the signature but does not send it back).
- Reasoning doubles memory usage on heavy use. The `events` table does not log reasoning deltas separately (only aggregated on the message row).

## Alternatives rejected

- **Mixing reasoning into the content channel**: makes rendering complex (how do you tell reasoning apart from the answer?).
- **Dropping reasoning entirely**: loses valuable traceability for debugging and the future web UI.
