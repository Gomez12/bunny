/**
 * OpenAI-compatible LLM adapter.
 *
 * Streaming-first: always sends `stream: true`. Returns an async iterable of
 * `StreamDelta` for live rendering and a `response` promise that resolves to
 * the fully-accumulated `LlmResponse` when the stream closes.
 *
 * Works against any OpenAI-compatible endpoint (OpenAI, OpenRouter, DeepSeek,
 * Ollama, vLLM, LiteLLM, …). Provider-specific reasoning fields are normalised
 * to `channel: "reasoning"` via the profile system.
 */

import type { LlmConfig } from "../config.ts";
import type {
  ChatMessage,
  ChatRequest,
  ContentPart,
  LlmResponse,
  StreamDelta,
} from "./types.ts";
import { getProfile } from "./profiles.ts";
import { parseStream } from "./stream.ts";
import { DeltaAccumulator } from "./delta.ts";
import type { ConcurrencyGate } from "./concurrency_gate.ts";

export interface StreamResult {
  /** Live deltas for rendering. */
  deltas: AsyncIterable<StreamDelta>;
  /** Resolves once the stream is fully consumed. */
  response: Promise<LlmResponse>;
}

/**
 * Optional knobs for `chat()`. `gate` is the upstream concurrency chokepoint
 * (ADR 0035); the two callbacks surface queue state to the caller's renderer.
 * Both callbacks fire only when the request actually had to wait.
 */
export interface ChatOpts {
  gate?: ConcurrencyGate;
  onQueueWait?: (ev: { position: number }) => void;
  onQueueRelease?: (ev: { waitedMs: number }) => void;
}

/**
 * Serialize one ChatMessage for the wire. When `attachments` are present on
 * a user turn, content is upgraded to the OpenAI array form so vision-capable
 * models receive the images. Everything else is passed through unchanged
 * (the `attachments` field itself is stripped — providers don't know it).
 */
function serializeMessage(
  m: ChatMessage,
): ChatMessage | Record<string, unknown> {
  if (m.role !== "user" || !m.attachments || m.attachments.length === 0) {
    return m;
  }
  const parts: ContentPart[] = [];
  if (m.content && m.content.length > 0) {
    parts.push({ type: "text", text: m.content });
  }
  for (const a of m.attachments) {
    if (a.kind === "image") {
      parts.push({ type: "image_url", image_url: { url: a.dataUrl } });
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { attachments: _attachments, content: _content, ...rest } = m;
  return { ...rest, content: parts };
}

function buildRequestBody(req: ChatRequest, model: string): unknown {
  const body: Record<string, unknown> = {
    model: req.model ?? model,
    messages: req.messages.map(serializeMessage),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (req.tools && req.tools.length > 0) body["tools"] = req.tools;
  if (req.temperature !== undefined) body["temperature"] = req.temperature;
  if (req.max_tokens !== undefined) body["max_tokens"] = req.max_tokens;
  return body;
}

/**
 * Send a chat-completions request and return a streaming result.
 *
 * The returned `deltas` iterable and the `response` promise share the same
 * underlying stream. Consume `deltas` to drive the stream; `response` resolves
 * automatically when `deltas` is exhausted (or when you call `drainResponse`).
 */
export async function chat(
  cfg: LlmConfig,
  req: ChatRequest,
  opts: ChatOpts = {},
): Promise<StreamResult> {
  const url = cfg.baseUrl.replace(/\/$/, "") + "/chat/completions";
  const profile = getProfile(cfg.profile, cfg.baseUrl);

  // Acquire the upstream-concurrency gate BEFORE fetch so a queued request
  // doesn't hold an HTTP socket while waiting. `initialPosition > 0` means
  // the call had to queue — only then do the paired callbacks fire so the UI
  // never shows a "queue" badge for unqueued calls. The try/catch hands the
  // slot back if a renderer callback throws synchronously; otherwise an
  // orphaned waiter would inflate `inFlight` permanently.
  if (opts.gate) {
    const ticket = opts.gate.acquire();
    try {
      if (ticket.initialPosition > 0) {
        opts.onQueueWait?.({ position: ticket.initialPosition });
      }
      const { waitedMs } = await ticket.ready;
      if (ticket.initialPosition > 0) {
        opts.onQueueRelease?.({ waitedMs });
      }
    } catch (e) {
      ticket.cancel();
      throw e;
    }
  }

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    opts.gate?.release();
  };

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify(buildRequestBody(req, cfg.model)),
    });
  } catch (e) {
    release();
    throw e;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "(no body)");
    release();
    throw new LlmError(
      `LLM request failed: ${res.status} ${res.statusText} — ${text}`,
      res.status,
    );
  }

  if (!res.body) {
    release();
    throw new LlmError("LLM response has no body", 0);
  }

  const startMs = Date.now();
  const accumulator = new DeltaAccumulator();

  let resolveResponse!: (r: LlmResponse) => void;
  let rejectResponse!: (e: unknown) => void;
  const response = new Promise<LlmResponse>((res, rej) => {
    resolveResponse = res;
    rejectResponse = rej;
  });

  // The generator pushes into the accumulator on every yield. The `finally`
  // block releases the gate AND cancels the underlying response body — the
  // latter matters when the caller breaks out of the iterator early, so the
  // socket and reader buffer don't linger until V8 GC notices.
  async function* fanOut(): AsyncIterable<StreamDelta> {
    try {
      for await (const delta of parseStream(res.body!, profile)) {
        accumulator.push(delta);
        yield delta;
      }
      resolveResponse(accumulator.finish(startMs));
    } catch (e) {
      rejectResponse(e);
      throw e;
    } finally {
      release();
      void res.body?.cancel().catch(() => undefined);
    }
  }

  return { deltas: fanOut(), response };
}

/**
 * Convenience: consume the full stream and return the final response without
 * yielding individual deltas. Useful in tests and non-streaming contexts.
 */
export async function chatSync(
  cfg: LlmConfig,
  req: ChatRequest,
  opts: ChatOpts = {},
): Promise<LlmResponse> {
  const { deltas, response } = await chat(cfg, req, opts);
  // Drain the deltas so the generator runs to completion and resolves `response`.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _d of deltas) {
    /* drain */
  }
  return response;
}

export class LlmError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
}
