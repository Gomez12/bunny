/**
 * Server-Sent Events parser that turns a `ReadableStream<Uint8Array>` (from a
 * streaming chat-completions response) into an `AsyncIterable<StreamDelta>`.
 *
 * Handles:
 *  - Multi-byte SSE lines split across chunks
 *  - `data: [DONE]` termination
 *  - Skipped / empty lines
 *  - Provider-specific reasoning fields (via Profile)
 */

import type { StreamDelta, UsageDelta } from "./types.ts";
import type { Profile, RawDelta, RawToolCallDelta } from "./profiles.ts";

/** Internal raw chunk shape — only fields we care about. */
interface RawChunk {
  choices?: Array<{
    index: number;
    delta: RawDelta;
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  } | null;
}

/** Decode Uint8Array → lines, accumulating across chunk boundaries. */
function* splitLines(
  buf: string,
  incoming: string,
): Generator<[string, string]> {
  const combined = buf + incoming;
  const lines = combined.split("\n");
  // Last element may be incomplete — return it as new buffer.
  for (let i = 0; i < lines.length - 1; i++) {
    yield [lines[i]!, ""];
  }
  yield ["", lines[lines.length - 1]!]; // sentinel: remainder
}

/**
 * Parse a streaming response body as Server-Sent Events and emit `StreamDelta`
 * objects for every meaningful chunk.
 */
export async function* parseStream(
  body: ReadableStream<Uint8Array>,
  profile: Profile,
  choiceIndex = 0,
): AsyncIterable<StreamDelta> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buf = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = decoder.decode(value, { stream: true });
      const combined = buf + text;
      const lines = combined.split("\n");
      buf = lines.pop() ?? ""; // keep incomplete last line

      for (const line of lines) {
        const trimmed = line.trimEnd();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") return;
        if (!payload) continue;

        let chunk: RawChunk;
        try {
          chunk = JSON.parse(payload) as RawChunk;
        } catch {
          // Malformed chunk — skip.
          continue;
        }

        // Usage chunk (may appear in last delta for some providers)
        if (chunk.usage) {
          const u = chunk.usage;
          const usage: UsageDelta = {
            channel: "usage",
            promptTokens: u.prompt_tokens ?? 0,
            completionTokens: u.completion_tokens ?? 0,
            totalTokens: u.total_tokens ?? 0,
          };
          yield usage;
        }

        for (const choice of chunk.choices ?? []) {
          const delta = choice.delta;

          // Reasoning (provider-normalised)
          const reasoningText = profile.extractReasoning(delta);
          if (reasoningText) {
            yield {
              channel: "reasoning",
              index: choiceIndex,
              text: reasoningText,
            };
          }

          // Content
          if (delta.content) {
            yield {
              channel: "content",
              index: choiceIndex,
              text: delta.content,
            };
          }

          // Tool calls
          for (const tc of delta.tool_calls ?? []) {
            yield {
              channel: "tool_call",
              index: choiceIndex,
              callIndex: tc.index,
              id: tc.id,
              name: tc.function?.name,
              argsDelta: tc.function?.arguments ?? "",
            };
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Type guard helpers used by the accumulator. */
export function isRawToolCallDelta(v: unknown): v is RawToolCallDelta {
  return typeof v === "object" && v !== null && "index" in v;
}
