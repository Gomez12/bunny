# Bunny — architectuur

Bunny is een Bun-native AI agent. Drie ontwerpprincipes:

1. **Minimal agent loop** — conversation history + tool registry + LLM + executor. Niets meer. (Zie Mihail Eric, _The Emperor Has No Clothes_.)
2. **Queue is the spine** — élke LLM-call, tool-call en memory-write is een job op [bunqueue](https://github.com/egeominotti/bunqueue). Middleware logt input/output/duration naar SQLite. Niets verdwijnt ongezien.
3. **Portable state** — alles relatief aan cwd onder `./.bunny/` (override via `$BUNNY_HOME`). Geen `$HOME/.config`. Een project-map is een volledige, meeverhuisbare agent.

## Data-flow (één turn)

```
CLI ──► runAgent(prompt)
          │
          ▼
     queue.llm ──► adapter SSE stream
          │              │
          │              ├──► delta: content    ─► render (plain)
          │              ├──► delta: reasoning  ─► render (dim italic)
          │              └──► delta: tool_call  ─► render (cyan)
          │
          ▼
       accumulated message ──► events + messages (+ FTS5 + vector embedding)
          │
          ▼
       tool_calls? ──► queue.tool ──► fs_read / fs_list / fs_edit
          │                              │
          └──────────────────────────────┘  (loop until assistant answers without tool_calls)
```

Volgende turn leest `recall.hybrid(prompt, k=8)` uit memory — top-k messages via Reciprocal Rank Fusion over BM25 (SQLite FTS5) en kNN (sqlite-vec).

## Provider-profielen (streaming + reasoning)

| Profiel            | content                           | reasoning                             |
| ------------------ | --------------------------------- | ------------------------------------- |
| `openai`           | `choices[].delta.content`         | `choices[].delta.reasoning_content`\* |
| `deepseek`         | `choices[].delta.content`         | `choices[].delta.reasoning_content`   |
| `openrouter`       | pass-through (per model)          | pass-through                          |
| `ollama`           | `choices[].delta.content`         | — (meestal afwezig)                   |
| `anthropic-compat` | content-block                     | `thinking` block + signature          |

\* Alleen o1/o3 en specifieke varianten; andere OpenAI-modellen bevatten geen reasoning.

Reasoning wordt op `messages.channel='reasoning'` bewaard (zichtbaar in UI, niet meegenomen in recall tenzij `[memory].index_reasoning = true`), en **niet** teruggestuurd naar de LLM in vervolgturns — behalve voor providers waar dat vereist is (Anthropic thinking-blocks met signature roundtrip).

## Web UI

Naast de CLI draait Bunny een web-UI (`bunny serve`) met twee tabs: **Chat** (live streaming) en **Messages** (alle eerdere sessies, BM25-zoekbaar). Zie [ADR 0006](./adr/0006-web-ui.md) voor de opzet. De agent loop is ongewijzigd — de webserver plugt op dezelfde `Renderer`-interface als de CLI (via `createSseRenderer`).

## Zie ook

- [ADR 0001 — Bun als runtime](./adr/0001-bun-runtime.md)
- ADR 0002 — OpenAI-compat adapter _(TBD)_
- ADR 0003 — SQLite FTS5 + sqlite-vec hybrid memory _(TBD)_
- ADR 0004 — Bunqueue als spine _(TBD)_
- ADR 0005 — Streaming en reasoning-normalisatie _(TBD)_
- [ADR 0006 — Web UI (Chat + Messages)](./adr/0006-web-ui.md)
