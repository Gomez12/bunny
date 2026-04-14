# ADR 0005 — Streaming en reasoning-normalisatie

**Status:** Accepted
**Datum:** 2026-04-14

## Context

Reasoning-capable LLM's (OpenAI o1/o3, DeepSeek-R1, Anthropic Claude met extended thinking) geven hun "denkproces" terug via een apart veld in de streaming response. Dit veld verschilt per provider:

| Provider | Veld |
|----------|------|
| OpenAI o1/o3 | `choices[n].delta.reasoning_content` |
| DeepSeek | `choices[n].delta.reasoning_content` |
| OpenRouter | pass-through (afhankelijk van onderliggend model) |
| Anthropic-compat (via LiteLLM e.d.) | `choices[n].delta.thinking` + signature roundtrip |

De CLI moet reasoning in een onderscheidbare kleur tonen, terwijl het niet de recall-index vervuilt.

## Beslissing

1. **Streaming-first adapter**: `adapter.chat()` retourneert altijd `AsyncIterable<StreamDelta>`. Elk delta heeft een `channel: "content" | "reasoning" | "tool_call" | "usage"`.
2. **Provider-profielen** (`src/llm/profiles.ts`): normaliseren alle reasoning-velden naar `channel: "reasoning"`.
3. **CLI renderer** (`src/agent/render.ts`): mapt channels naar ANSI-kleuren. Reasoning = dim italic in een collapsible "╭─ thinking ─╮" blok dat sluit zodra content begint.
4. **Persistentie**: reasoning wordt als aparte rij opgeslagen (`messages.channel = 'reasoning'`). Niet in FTS5/vector geïndexeerd tenzij `[memory].index_reasoning = true`.
5. **Roundtrip-regel**: reasoning wordt NIET terug de LLM ingevoerd in vervolgturns (behalve Anthropic-compat thinking-blocks met signature — provider-profiel bepaalt dit).
6. **TTY-detectie**: ANSI-codes alleen in TTY-context. In pipes/CI: reasoning-regels geprefixed met `[thinking]` of weggelaten via `--hide-reasoning` / `render.reasoning = "hidden"`.

## Consequenties

- De `render.reasoning` instelling (`"collapsed" | "inline" | "hidden"`) moet worden doorgegeven aan de renderer. Default is `"collapsed"`.
- Voor Anthropic-compat providers met thinking-blocks: `ChatMessage.provider_sig` moet meegestuurd worden in het volgende request. Dit is nog niet geïmplementeerd in fase 1 (de agent loop slaat de signature op maar stuurt hem niet terug).
- Reasoning verdubbelt het geheugengebruik bij intensief gebruik. De `events` tabel logt reasoning-deltas niet afzonderlijk (alleen geaggregeerd in de message-row).

## Alternatieven verworpen

- **Reasoning in content-kanaal mixen**: maakt rendering complex (hoe herken je reasoning vs. antwoord?).
- **Reasoning helemaal weggooien**: verliest waardevolle traceability voor debugging en de toekomstige web-UI.
