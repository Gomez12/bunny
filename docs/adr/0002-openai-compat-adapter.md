# ADR 0002 — OpenAI-compat adapter (streaming-first, geen SDK)

**Status:** Accepted
**Datum:** 2026-04-14

## Context

De agent moet met meerdere LLM-providers kunnen werken: OpenAI, OpenRouter, DeepSeek, Ollama, vLLM, LiteLLM. Opties:
1. Per-provider SDK (Anthropic SDK, OpenAI SDK, …)
2. LangChain / LlamaIndex as abstractielaag
3. Dunne eigen fetch-client die de OpenAI-compat spec implementeert

## Beslissing

Dunne eigen `fetch`-based adapter, streaming-first, geen externe LLM-SDK als productie-afhankelijkheid.

## Onderbouwing

- **Geen vendor lock-in**: providers worden geconfigureerd via base URL + API key. Wisselen van OpenAI naar Ollama is één env var.
- **Streaming first**: `adapter.chat()` retourneert altijd een `AsyncIterable<StreamDelta>` — reasoning, content en tool_calls als aparte kanalen. Non-streaming is een wrapper die draint.
- **Reasoning normalisatie**: `StreamDelta.channel = "reasoning"` abstracteert over `reasoning_content` (OpenAI o1/o3, DeepSeek), `thinking` (Anthropic-compat). Eén rendering-pad voor alle providers.
- **Provider-profielen** (`src/llm/profiles.ts`): lookup op base-URL-hint of expliciete config. Geeft extractielogica per provider voor reasoning-veld en roundtrip-vereisten.
- **Geen externe deps**: `fetch` is ingebouwd in Bun (en alle moderne runtimes). De SSE-parser (`stream.ts`) is ~80 regels; de delta-accumulator (`delta.ts`) is ~60 regels.

## Consequenties

- Bij breaking changes in de OpenAI API (field renames, streaming protocol) moeten we de adapter updaten — maar dat is beperkt tot één bestand.
- Multi-turn reasoning roundtrip voor Anthropic-compat (thinking-block met signature) vereist dat de `ChatMessage.provider_sig` meegegeven wordt in het volgende request; de agent loop is daarvoor verantwoordelijk.

## Alternatieven verworpen

- **OpenAI SDK**: brengt Node-compat afhankelijkheden mee; biedt geen abstractie over reasoning-kanalen.
- **Vercel AI SDK**: zware transitive deps; wil opinionated streaming format opleggen.
- **LangChain**: enorme dependency-boom voor wat neerkomt op één POST-request.
