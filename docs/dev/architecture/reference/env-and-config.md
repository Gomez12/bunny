# Environment + config

Secrets live in `.env`. Everything else lives in `bunny.config.toml`. State location lives in `$BUNNY_HOME`.

## `.env`

| Variable | Purpose |
| --- | --- |
| `LLM_API_KEY` | Used for every LLM call. |
| `EMBED_API_KEY` | Used for embeddings. Optional — without it, recall degrades to BM25-only. |
| `SERP_API_KEY` | Optional; enables the serper.dev-backed `web_search`. Fallback: DuckDuckGo HTML scraping + Bing. |
| `BUNNY_API_KEY` | Optional; the CLI uses it to authenticate against a remote Bunny. If unset, the CLI runs as the seeded `system` user. |
| `BUNNY_DEFAULT_ADMIN_PASSWORD` | Overrides the seeded admin's initial password (default `admin`). `must_change_pw = 1` so the admin is forced to change it on first login. |

Anything else can go in `bunny.config.toml`.

## `bunny.config.toml`

Canonical loader: `src/config.ts`. Every section is optional; defaults apply when absent.

```toml
[agent]
default_project = "general"        # also a directory name under $BUNNY_HOME/projects/
system_prompt = "You are …"         # base prompt; project + agent can extend
```

```toml
[memory]
last_n = 10                         # short-term replay depth
recall_k = 8                        # hybrid-recall top-k
embedding_dim = 1536                # baked into vec0 at DB open
index_reasoning = false             # whether to FTS-index reasoning rows (default no)
```

```toml
[llm]
provider = "openai"                 # openai | deepseek | openrouter | ollama | anthropic-compat
endpoint = "https://api.openai.com/v1/chat/completions"
model = "gpt-4.1"
temperature = 0.2
max_tokens = 4096
```

```toml
[web]
serp_provider = "serper"            # or empty — falls back to DuckDuckGo + Bing
serp_base_url = "https://google.serper.dev"
user_agent = "Bunny (+https://…)"
# serp_api_key is env-preferred: SERP_API_KEY
```

```toml
[auth]
[auth.defaultAdmin]
username = "admin"                  # override via $BUNNY_DEFAULT_ADMIN_USERNAME if added
# password comes from $BUNNY_DEFAULT_ADMIN_PASSWORD
```

```toml
[translation]
max_per_tick = 50                   # rows claimed per scheduler tick
max_document_bytes = 50000
stuck_threshold_ms = 1_800_000      # 30 min
system_prompt = "You are a translator. …"
```

```toml
[telegram]
poll_lease_ms = 50_000
chunk_chars = 4000
document_fallback_bytes = 16_000
public_base_url = ""                # env override: BUNNY_PUBLIC_BASE_URL
```

## Env overrides

| Env | Overrides |
| --- | --- |
| `BUNNY_HOME` | State directory. Default: `./.bunny`. |
| `BUNNY_DEFAULT_PROJECT` | `[agent].default_project`. |
| `BUNNY_SYSTEM_PROMPT` | `[agent].system_prompt`. |
| `BUNNY_DEFAULT_ADMIN_PASSWORD` | `[auth.defaultAdmin]` password. |
| `BUNNY_PUBLIC_BASE_URL` | `[telegram].public_base_url`. Must be HTTPS with a public cert. |
| `TRANSLATION_MAX_PER_TICK` | `[translation].max_per_tick`. |
| `SERP_API_KEY` | `[web].serp_api_key` (not stored in TOML). |

## Per-project overrides

- **System prompt:** `$BUNNY_HOME/projects/<name>/systemprompt.toml` with `prompt = "…"` and `append = true|false`. `append = true` (default) concatenates after the base; `append = false` replaces.
- **Memory knobs (`last_n`, `recall_k`):** also settable in `systemprompt.toml` — precedence **agent → project → global**.

## Per-agent overrides

`$BUNNY_HOME/agents/<name>/config.toml`:

```toml
description = "…"
system_prompt = "You are …"
append = false                      # default for agents — replaces project/base
tools = ["fs_read", "fs_list"]      # whitelist; empty/missing = inherit all
last_n = 5
recall_k = 4
context_scope = "own"               # or 'full'
is_subagent = false
allowed_subagents = ["helper"]
```

## Runtime precedence summary

System prompt: base ← project (`append`) ← agent (`append`).

Memory knobs: agent ← project ← global `[memory]`.

Tool registry: global registry ← subset(agent whitelist) ← dynamic tools spliced per run.

## Related

- [`../getting-started/setup.md`](../getting-started/setup.md) — minimum viable `.env`.
- [`../concepts/projects-as-scope.md`](../concepts/projects-as-scope.md) — per-project prompts.
- [`../concepts/agent-loop.md`](../concepts/agent-loop.md) — how options flow.
- [ADR 0002 — OpenAI-compat adapter](../../adr/0002-openai-compat-adapter.md)
- [ADR 0022 — Multi-language translation](../../adr/0022-multi-language-translation.md)
- [ADR 0028 — Per-project Telegram integration](../../adr/0028-telegram-integration.md)
