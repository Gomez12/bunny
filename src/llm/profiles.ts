/**
 * Provider profiles.
 *
 * Different OpenAI-compatible providers surface reasoning in different fields.
 * This module normalises them all to a single `channel: "reasoning"` delta.
 *
 * Profile selection:
 *  1. Explicit config / env (LLM_PROFILE)
 *  2. Base-URL heuristic
 *  3. "openai" as safe default
 */

import type { LlmProfile } from "../config.ts";

export interface Profile {
  id: LlmProfile;
  /**
   * Extract reasoning text from a raw streaming chunk delta object.
   * Returns `undefined` when this chunk carries no reasoning.
   */
  extractReasoning(delta: RawDelta): string | undefined;
  /**
   * Whether this provider requires the thinking block (with signature) to be
   * echoed back in the next request. If true the agent will carry
   * `provider_sig` forward.
   */
  requiresSignatureRoundtrip: boolean;
}

/** The raw shape of `choices[n].delta` from an OpenAI-compat chunk. */
export interface RawDelta {
  content?: string | null;
  /** OpenAI o1/o3 and DeepSeek */
  reasoning_content?: string | null;
  /** Anthropic-compat (via LiteLLM etc) */
  thinking?: string | null;
  tool_calls?: RawToolCallDelta[];
  role?: string;
}

export interface RawToolCallDelta {
  index: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

// ---------------------------------------------------------------------------

const openaiProfile: Profile = {
  id: "openai",
  extractReasoning: (d) => d.reasoning_content ?? undefined,
  requiresSignatureRoundtrip: false,
};

const deepseekProfile: Profile = {
  id: "deepseek",
  extractReasoning: (d) => d.reasoning_content ?? undefined,
  requiresSignatureRoundtrip: false,
};

const openrouterProfile: Profile = {
  id: "openrouter",
  // OpenRouter passes through whatever the underlying model provides.
  extractReasoning: (d) => d.reasoning_content ?? undefined,
  requiresSignatureRoundtrip: false,
};

const ollamaProfile: Profile = {
  id: "ollama",
  extractReasoning: (_d) => undefined,
  requiresSignatureRoundtrip: false,
};

const anthropicCompatProfile: Profile = {
  id: "anthropic-compat",
  extractReasoning: (d) => d.thinking ?? undefined,
  requiresSignatureRoundtrip: true,
};

const PROFILES: Record<LlmProfile, Profile> = {
  openai: openaiProfile,
  deepseek: deepseekProfile,
  openrouter: openrouterProfile,
  ollama: ollamaProfile,
  "anthropic-compat": anthropicCompatProfile,
};

/** Guess profile from base URL when no explicit override is set. */
export function detectProfile(baseUrl: string): LlmProfile {
  const lower = baseUrl.toLowerCase();
  if (lower.includes("api.openai.com")) return "openai";
  if (lower.includes("openrouter.ai")) return "openrouter";
  if (lower.includes("deepseek.com")) return "deepseek";
  if (lower.includes("localhost") || lower.includes("127.0.0.1") || lower.includes("ollama")) return "ollama";
  if (lower.includes("anthropic") || lower.includes("litellm")) return "anthropic-compat";
  return "openai"; // safest fallback: no-op reasoning extraction
}

export function getProfile(id: LlmProfile | undefined, baseUrl: string): Profile {
  const resolved = id ?? detectProfile(baseUrl);
  return PROFILES[resolved];
}
