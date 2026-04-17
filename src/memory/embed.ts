/**
 * Embedding generation via OpenAI-compatible `/embeddings` endpoint.
 *
 * Falls back gracefully to a zero-vector when no API key is configured, so
 * the rest of the system still works (recall just won't be semantic).
 */

import type { EmbedConfig } from "../config.ts";

const EMBED_CACHE_MAX = 32;
const embedCache = new Map<string, number[]>();

export class EmbedError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "EmbedError";
  }
}

/**
 * Generate an embedding vector for `text`.
 * Returns a number[] of length `cfg.dim`.
 */
export async function embed(cfg: EmbedConfig, text: string): Promise<number[]> {
  if (!cfg.apiKey) {
    return new Array<number>(cfg.dim).fill(0);
  }

  const cacheKey = `${cfg.model}:${text}`;
  const cached = embedCache.get(cacheKey);
  if (cached) return cached;

  const url = cfg.baseUrl.replace(/\/$/, "") + "/embeddings";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({ model: cfg.model, input: text }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new EmbedError(`Embeddings API ${res.status}: ${body}`, res.status);
  }

  interface EmbedResponse {
    data: Array<{ embedding: number[] }>;
  }
  const json = (await res.json()) as EmbedResponse;
  const vec = json.data[0]?.embedding;
  if (!vec) throw new EmbedError("Empty embedding response", 0);

  if (embedCache.size >= EMBED_CACHE_MAX) {
    const first = embedCache.keys().next().value!;
    embedCache.delete(first);
  }
  embedCache.set(cacheKey, vec);

  return vec;
}
