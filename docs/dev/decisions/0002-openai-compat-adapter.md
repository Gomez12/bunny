# ADR 0002 — OpenAI-compat adapter (streaming-first, no SDK)

**Status:** Accepted
**Date:** 2026-04-14

## Context

The agent must work with multiple LLM providers: OpenAI, OpenRouter, DeepSeek, Ollama, vLLM, LiteLLM. Options:
1. Per-provider SDK (Anthropic SDK, OpenAI SDK, …)
2. LangChain / LlamaIndex as an abstraction layer
3. Thin in-house fetch client that implements the OpenAI-compat spec

## Decision

Thin in-house `fetch`-based adapter, streaming-first, no external LLM SDK as a production dependency.

## Rationale

- **No vendor lock-in**: providers are configured via base URL + API key. Switching from OpenAI to Ollama is one env var.
- **Streaming first**: `adapter.chat()` always returns an `AsyncIterable<StreamDelta>` — reasoning, content and tool_calls as separate channels. Non-streaming is a wrapper that drains.
- **Reasoning normalisation**: `StreamDelta.channel = "reasoning"` abstracts over `reasoning_content` (OpenAI o1/o3, DeepSeek), `thinking` (Anthropic-compat). One rendering path for all providers.
- **Provider profiles** (`src/llm/profiles.ts`): lookup by base-URL hint or explicit config. Supplies extraction logic per provider for the reasoning field and roundtrip requirements.
- **No external deps**: `fetch` is built into Bun (and all modern runtimes). The SSE parser (`stream.ts`) is ~80 lines; the delta accumulator (`delta.ts`) is ~60 lines.

## Consequences

- On breaking changes in the OpenAI API (field renames, streaming protocol) we have to update the adapter — but that is contained in one file.
- Multi-turn reasoning roundtrip for Anthropic-compat (thinking block with signature) requires that `ChatMessage.provider_sig` is passed along on the next request; the agent loop is responsible for that.

## Alternatives rejected

- **OpenAI SDK**: brings Node-compat dependencies; offers no abstraction over reasoning channels.
- **Vercel AI SDK**: heavy transitive deps; wants to impose an opinionated streaming format.
- **LangChain**: enormous dependency tree for what amounts to one POST request.
