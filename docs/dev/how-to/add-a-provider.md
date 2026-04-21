# Add an LLM provider

## When you need this

A new OpenAI-compatible (or otherwise) LLM provider. All provider-specific quirks live in `src/llm/profiles.ts` — the adapter and stream parser stay provider-agnostic.

## Steps

1. **Identify the quirks.** Ask the provider's docs:
   - Is it pure OpenAI-compat (`/v1/chat/completions` with `choices[].delta.content`)?
   - Does it carry reasoning? Where? (`choices[].delta.reasoning_content`? An Anthropic-style `thinking` block?)
   - Does it require special headers? (`Anthropic-Version`, etc.)
   - Does it need a signature roundtrip for reasoning? (Anthropic-compat does.)

2. **Add a profile case in `src/llm/profiles.ts`:**
   ```ts
   case "my_provider": {
     return {
       name: "my_provider",
       endpoint: cfg.endpoint ?? "https://api.my-provider.com/v1/chat/completions",
       headers: {
         Authorization: `Bearer ${cfg.apiKey}`,
         "Content-Type": "application/json",
         // Provider-specific headers:
         "My-Provider-Version": "2024-01-01",
       },
       extractContentDelta(delta) {
         return delta.choices?.[0]?.delta?.content ?? "";
       },
       extractReasoningDelta(delta) {
         return delta.choices?.[0]?.delta?.reasoning_content ?? "";
       },
       // Only if the provider requires signature roundtripping:
       extractProviderSig(message) {
         return message?.thinking?.[0]?.signature ?? null;
       },
       emitThinkingBlock: false, // true for Anthropic-compat
     };
   }
   ```

3. **Update the provider type union** in `src/config.ts` or wherever the provider name is enumerated so the config file validates.

4. **Add a config example.** Document in `docs/dev/reference/env-and-config.md` or `docs/adr/0002-openai-compat-adapter.md`.

5. **Test.** Write a fixture test that feeds the profile a synthetic SSE stream and checks the delta extraction:
   ```ts
   test("my_provider extracts content", () => {
     const profile = getProfile("my_provider", {…});
     const delta = { choices: [{ delta: { content: "hi" } }] };
     expect(profile.extractContentDelta(delta)).toBe("hi");
   });
   ```

## Rules

- **Every provider branch in `profiles.ts`.** No `if (provider === …)` anywhere else.
- **Reasoning is display-only for most providers.** Do not send it back on the next turn — except when the provider requires signature roundtripping (Anthropic-compat).
- **SSE framing is the same.** `data: {json}\n\n`. The parser in `stream.ts` handles multi-byte safely.
- **Endpoints can be overridden in `bunny.config.toml`.** `[llm] endpoint = "…"`.

## Validation

```sh
bun test tests/llm/profiles.test.ts
```

Manual:

```sh
LLM_API_KEY=<key> bun run src/index.ts "hello from my_provider" \
  --config bunny.config.toml  # with [llm] provider = "my_provider"
```

Watch for:

- Content streams cleanly to the terminal.
- Reasoning (if supported) appears dim-italic.
- Final stats show token counts.

## Related

- [ADR 0002 — OpenAI-compat adapter](../../adr/0002-openai-compat-adapter.md)
- [ADR 0005 — Streaming and reasoning normalisation](../../adr/0005-streaming-reasoning.md)
- [`../concepts/streaming-and-renderers.md`](../concepts/streaming-and-renderers.md)
- `src/llm/profiles.ts` — every existing profile is reference material.
