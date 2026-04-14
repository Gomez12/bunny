/**
 * Runtime configuration.
 *
 * Source precedence (highest wins):
 *  1. Environment variables
 *  2. `bunny.config.toml` in cwd
 *  3. Hard-coded defaults
 *
 * Env vars are the canonical source for secrets (API keys). TOML is for
 * project-level choices you commit to git.
 */

import { existsSync, readFileSync } from "node:fs";
import { paths } from "./paths.ts";

/** Rendering mode for the reasoning stream in the CLI. */
export type ReasoningRenderMode = "collapsed" | "inline" | "hidden";

/** Provider profile — controls SSE parsing + reasoning roundtrip behaviour. */
export type LlmProfile = "openai" | "deepseek" | "openrouter" | "ollama" | "anthropic-compat";

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  modelReasoning: string | undefined;
  profile: LlmProfile | undefined;
}

export interface EmbedConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  dim: number;
}

export interface MemoryConfig {
  indexReasoning: boolean;
  recallK: number;
}

export interface RenderConfig {
  reasoning: ReasoningRenderMode;
  color: boolean | undefined;
}

export interface QueueConfig {
  topics: readonly string[];
}

export interface BunnyConfig {
  llm: LlmConfig;
  embed: EmbedConfig;
  memory: MemoryConfig;
  render: RenderConfig;
  queue: QueueConfig;
  sessionId: string | undefined;
}

// ---------------------------------------------------------------------------
// Internals

interface TomlShape {
  llm?: Partial<{ base_url: string; model: string; model_reasoning: string; profile: string }>;
  embed?: Partial<{ base_url: string; model: string; dim: number }>;
  memory?: Partial<{ index_reasoning: boolean; recall_k: number }>;
  render?: Partial<{ reasoning: string; color: boolean }>;
  queue?: Partial<{ topics: string[] }>;
}

const DEFAULTS = {
  llm: {
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    model: "gpt-4o-mini",
    modelReasoning: undefined as string | undefined,
    profile: undefined as LlmProfile | undefined,
  },
  embed: {
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    model: "text-embedding-3-small",
    dim: 1536,
  },
  memory: { indexReasoning: false, recallK: 8 },
  render: { reasoning: "collapsed" as ReasoningRenderMode, color: undefined as boolean | undefined },
  queue: { topics: ["llm", "tool", "memory"] as readonly string[] },
} as const;

const VALID_PROFILES: readonly LlmProfile[] = ["openai", "deepseek", "openrouter", "ollama", "anthropic-compat"];
const VALID_REASONING: readonly ReasoningRenderMode[] = ["collapsed", "inline", "hidden"];

function parseProfile(raw: string | undefined): LlmProfile | undefined {
  if (!raw) return undefined;
  return (VALID_PROFILES as readonly string[]).includes(raw) ? (raw as LlmProfile) : undefined;
}

function parseReasoningMode(raw: string | undefined): ReasoningRenderMode | undefined {
  if (!raw) return undefined;
  return (VALID_REASONING as readonly string[]).includes(raw) ? (raw as ReasoningRenderMode) : undefined;
}

function loadToml(file: string): TomlShape {
  if (!existsSync(file)) return {};
  const raw = readFileSync(file, "utf8");
  // Bun's TOML loader handles this via `import … with { type: "toml" }` but
  // we want file-path resolution at runtime from cwd, so parse the text.
  // Bun exposes Bun.TOML.parse since 1.1; fall back to a throw if absent so
  // we notice early instead of silently ignoring config.
  const parser = (Bun as unknown as { TOML?: { parse(src: string): unknown } }).TOML;
  if (!parser) throw new Error("Bun.TOML not available — require Bun ≥ 1.1");
  return parser.parse(raw) as TomlShape;
}

// ---------------------------------------------------------------------------
// Public API

/**
 * Build the effective configuration.
 *
 * Pure-ish: reads `process.env` and (if present) `./bunny.config.toml`.
 * Pass explicit overrides to make this deterministic in tests.
 */
export function loadConfig(opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): BunnyConfig {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const toml = loadToml(paths.configFile(cwd));

  const llm: LlmConfig = {
    baseUrl: env["LLM_BASE_URL"] ?? toml.llm?.base_url ?? DEFAULTS.llm.baseUrl,
    apiKey: env["LLM_API_KEY"] ?? "",
    model: env["LLM_MODEL"] ?? toml.llm?.model ?? DEFAULTS.llm.model,
    modelReasoning: env["LLM_MODEL_REASONING"] ?? toml.llm?.model_reasoning,
    profile: parseProfile(env["LLM_PROFILE"] ?? toml.llm?.profile),
  };

  const embed: EmbedConfig = {
    baseUrl: env["EMBED_BASE_URL"] ?? toml.embed?.base_url ?? DEFAULTS.embed.baseUrl,
    apiKey: env["EMBED_API_KEY"] ?? env["LLM_API_KEY"] ?? "",
    model: env["EMBED_MODEL"] ?? toml.embed?.model ?? DEFAULTS.embed.model,
    dim: Number(env["EMBED_DIM"] ?? toml.embed?.dim ?? DEFAULTS.embed.dim),
  };

  const memory: MemoryConfig = {
    indexReasoning: toml.memory?.index_reasoning ?? DEFAULTS.memory.indexReasoning,
    recallK: toml.memory?.recall_k ?? DEFAULTS.memory.recallK,
  };

  const render: RenderConfig = {
    reasoning: parseReasoningMode(toml.render?.reasoning) ?? DEFAULTS.render.reasoning,
    color: toml.render?.color,
  };

  const queue: QueueConfig = {
    topics: toml.queue?.topics ?? DEFAULTS.queue.topics,
  };

  return {
    llm,
    embed,
    memory,
    render,
    queue,
    sessionId: env["BUNNY_SESSION"],
  };
}
