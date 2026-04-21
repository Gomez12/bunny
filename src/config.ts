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
export type LlmProfile =
  | "openai"
  | "deepseek"
  | "openrouter"
  | "ollama"
  | "anthropic-compat";

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
  /**
   * How many recent user/assistant content turns to replay verbatim in every
   * request. Keeps short-term conversational coherence that BM25+kNN recall
   * alone can miss. 0 disables verbatim replay (recall-only mode).
   */
  lastN: number;
}

export interface RenderConfig {
  reasoning: ReasoningRenderMode;
  color: boolean | undefined;
}

export interface QueueConfig {
  topics: readonly string[];
}

export interface AuthConfig {
  /** Username for the seeded admin user (only used when `users` table is empty). */
  defaultAdminUsername: string;
  /** Password for the seeded admin user. User is forced to change it on first login. */
  defaultAdminPassword: string;
  /** Web session cookie TTL in hours. */
  sessionTtlHours: number;
}

export interface AgentConfig {
  /** Base system prompt prepended to every conversation (before project overrides). */
  systemPrompt: string;
  /** Default project name used when the caller doesn't specify one. */
  defaultProject: string;
  /**
   * Name of the agent bound to a chat turn when the caller doesn't specify
   * one and the prompt doesn't start with `@name`. Seeded at boot by
   * `src/memory/agents_seed.ts` and auto-linked to every project.
   */
  defaultAgent: string;
}

export interface UiConfig {
  /** Autosave debounce interval in milliseconds (used by whiteboard and other editors). */
  autosaveIntervalMs: number;
}

export interface WebConfig {
  /** SERP API key (e.g. serper.dev). Empty = DuckDuckGo fallback. */
  serpApiKey: string;
  /** SERP provider name. Currently only "serper" is supported. */
  serpProvider: string;
  /** Override for the SERP endpoint URL. */
  serpBaseUrl: string;
  /** Custom User-Agent for web requests. Empty = realistic Chrome default. */
  userAgent: string;
}

export interface TranslationConfig {
  /** Max sidecar rows translated per scheduler tick (cap on one-shot LLM fan-out). */
  maxPerTick: number;
  /** Upper bound on source markdown/text size — anything larger is rejected. */
  maxDocumentBytes: number;
  /** Threshold in ms after which a `translating` row is swept back to pending. */
  stuckThresholdMs: number;
  /** System prompt for the translation handler. Empty = hard-coded default. */
  systemPrompt: string;
}

export interface CodeConfig {
  /** Abort a clone if it hasn't finished within this many ms. */
  cloneTimeoutMs: number;
  /** Post-clone directory-size cap; anything larger is wiped + marked error. */
  maxRepoSizeMb: number;
  /** Shallow-clone depth; smaller = faster + less disk. */
  defaultCloneDepth: number;
}

export interface TelegramConfig {
  /** Lease TTL on a project's poll slot (ms). */
  pollLeaseMs: number;
  /** Max paragraphs per outbound sendMessage before we start chunking. */
  chunkChars: number;
  /** Above this size, an outbound reply is sent as a .md document instead. */
  documentFallbackBytes: number;
  /**
   * Public base URL used when registering webhooks. Required for
   * `transport='webhook'` to work; leave empty in local/dev setups (polling
   * works without it). Read from `BUNNY_PUBLIC_BASE_URL`.
   */
  publicBaseUrl: string;
}

export interface BunnyConfig {
  llm: LlmConfig;
  embed: EmbedConfig;
  memory: MemoryConfig;
  render: RenderConfig;
  queue: QueueConfig;
  auth: AuthConfig;
  agent: AgentConfig;
  ui: UiConfig;
  web: WebConfig;
  translation: TranslationConfig;
  telegram: TelegramConfig;
  code: CodeConfig;
  sessionId: string | undefined;
}

// ---------------------------------------------------------------------------
// Internals

interface TomlShape {
  llm?: Partial<{
    base_url: string;
    model: string;
    model_reasoning: string;
    profile: string;
  }>;
  embed?: Partial<{ base_url: string; model: string; dim: number }>;
  memory?: Partial<{
    index_reasoning: boolean;
    recall_k: number;
    last_n: number;
  }>;
  render?: Partial<{ reasoning: string; color: boolean }>;
  queue?: Partial<{ topics: string[] }>;
  auth?: Partial<{
    default_admin_username: string;
    default_admin_password: string;
    session_ttl_hours: number;
  }>;
  agent?: Partial<{
    system_prompt: string;
    default_project: string;
    default_agent: string;
  }>;
  ui?: Partial<{ autosave_interval_ms: number }>;
  web?: Partial<{
    serp_api_key: string;
    serp_provider: string;
    serp_base_url: string;
    user_agent: string;
  }>;
  translation?: Partial<{
    max_per_tick: number;
    max_document_bytes: number;
    stuck_threshold_ms: number;
    system_prompt: string;
  }>;
  telegram?: Partial<{
    poll_lease_ms: number;
    chunk_chars: number;
    document_fallback_bytes: number;
    public_base_url: string;
  }>;
  code?: Partial<{
    clone_timeout_ms: number;
    max_repo_size_mb: number;
    default_clone_depth: number;
  }>;
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
  memory: { indexReasoning: false, recallK: 8, lastN: 10 },
  render: {
    reasoning: "collapsed" as ReasoningRenderMode,
    color: undefined as boolean | undefined,
  },
  queue: { topics: ["llm", "tool", "memory"] as readonly string[] },
  auth: {
    defaultAdminUsername: "admin",
    defaultAdminPassword: "change-me",
    sessionTtlHours: 168,
  },
  agent: {
    systemPrompt: `You are Bunny, a helpful AI coding agent.

You have access to tools for reading, listing, and editing files in the working directory.
Use tools when you need to inspect or modify files. Think step-by-step before acting.
When you are done, reply with your final answer without making any more tool calls.`,
    defaultProject: "general",
    defaultAgent: "bunny",
  },
  ui: {
    autosaveIntervalMs: 5_000,
  },
  web: {
    serpApiKey: "",
    serpProvider: "serper",
    serpBaseUrl: "https://google.serper.dev/search",
    userAgent: "",
  },
  translation: {
    maxPerTick: 20,
    maxDocumentBytes: 30_720,
    stuckThresholdMs: 30 * 60 * 1000,
    systemPrompt: "",
  },
  telegram: {
    pollLeaseMs: 50_000,
    chunkChars: 4000,
    documentFallbackBytes: 16 * 1024,
    publicBaseUrl: "",
  },
  code: {
    cloneTimeoutMs: 5 * 60 * 1000,
    maxRepoSizeMb: 500,
    defaultCloneDepth: 50,
  },
} as const;

const VALID_PROFILES: readonly LlmProfile[] = [
  "openai",
  "deepseek",
  "openrouter",
  "ollama",
  "anthropic-compat",
];
const VALID_REASONING: readonly ReasoningRenderMode[] = [
  "collapsed",
  "inline",
  "hidden",
];

function parseProfile(raw: string | undefined): LlmProfile | undefined {
  if (!raw) return undefined;
  return (VALID_PROFILES as readonly string[]).includes(raw)
    ? (raw as LlmProfile)
    : undefined;
}

function parseReasoningMode(
  raw: string | undefined,
): ReasoningRenderMode | undefined {
  if (!raw) return undefined;
  return (VALID_REASONING as readonly string[]).includes(raw)
    ? (raw as ReasoningRenderMode)
    : undefined;
}

function loadToml(file: string): TomlShape {
  if (!existsSync(file)) return {};
  const raw = readFileSync(file, "utf8");
  // Bun's TOML loader handles this via `import … with { type: "toml" }` but
  // we want file-path resolution at runtime from cwd, so parse the text.
  // Bun exposes Bun.TOML.parse since 1.1; fall back to a throw if absent so
  // we notice early instead of silently ignoring config.
  const parser = (Bun as unknown as { TOML?: { parse(src: string): unknown } })
    .TOML;
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
export function loadConfig(
  opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): BunnyConfig {
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
    baseUrl:
      env["EMBED_BASE_URL"] ?? toml.embed?.base_url ?? DEFAULTS.embed.baseUrl,
    apiKey: env["EMBED_API_KEY"] ?? env["LLM_API_KEY"] ?? "",
    model: env["EMBED_MODEL"] ?? toml.embed?.model ?? DEFAULTS.embed.model,
    dim: Number(env["EMBED_DIM"] ?? toml.embed?.dim ?? DEFAULTS.embed.dim),
  };

  const memory: MemoryConfig = {
    indexReasoning:
      toml.memory?.index_reasoning ?? DEFAULTS.memory.indexReasoning,
    recallK: toml.memory?.recall_k ?? DEFAULTS.memory.recallK,
    lastN: toml.memory?.last_n ?? DEFAULTS.memory.lastN,
  };

  const render: RenderConfig = {
    reasoning:
      parseReasoningMode(toml.render?.reasoning) ?? DEFAULTS.render.reasoning,
    color: toml.render?.color,
  };

  const queue: QueueConfig = {
    topics: toml.queue?.topics ?? DEFAULTS.queue.topics,
  };

  const auth: AuthConfig = {
    defaultAdminUsername:
      env["BUNNY_DEFAULT_ADMIN_USERNAME"] ??
      toml.auth?.default_admin_username ??
      DEFAULTS.auth.defaultAdminUsername,
    defaultAdminPassword:
      env["BUNNY_DEFAULT_ADMIN_PASSWORD"] ??
      toml.auth?.default_admin_password ??
      DEFAULTS.auth.defaultAdminPassword,
    sessionTtlHours: Number(
      env["BUNNY_SESSION_TTL_HOURS"] ??
        toml.auth?.session_ttl_hours ??
        DEFAULTS.auth.sessionTtlHours,
    ),
  };

  const agent: AgentConfig = {
    systemPrompt:
      env["BUNNY_SYSTEM_PROMPT"] ??
      toml.agent?.system_prompt ??
      DEFAULTS.agent.systemPrompt,
    defaultProject:
      env["BUNNY_DEFAULT_PROJECT"] ??
      toml.agent?.default_project ??
      DEFAULTS.agent.defaultProject,
    defaultAgent:
      env["BUNNY_DEFAULT_AGENT"] ??
      toml.agent?.default_agent ??
      DEFAULTS.agent.defaultAgent,
  };

  const ui: UiConfig = {
    autosaveIntervalMs: Number(
      toml.ui?.autosave_interval_ms ?? DEFAULTS.ui.autosaveIntervalMs,
    ),
  };

  const web: WebConfig = {
    serpApiKey:
      env["SERP_API_KEY"] ?? toml.web?.serp_api_key ?? DEFAULTS.web.serpApiKey,
    serpProvider: toml.web?.serp_provider ?? DEFAULTS.web.serpProvider,
    serpBaseUrl: toml.web?.serp_base_url ?? DEFAULTS.web.serpBaseUrl,
    userAgent: toml.web?.user_agent ?? DEFAULTS.web.userAgent,
  };

  const translation: TranslationConfig = {
    maxPerTick: Number(
      env["TRANSLATION_MAX_PER_TICK"] ??
        toml.translation?.max_per_tick ??
        DEFAULTS.translation.maxPerTick,
    ),
    maxDocumentBytes: Number(
      toml.translation?.max_document_bytes ??
        DEFAULTS.translation.maxDocumentBytes,
    ),
    stuckThresholdMs: Number(
      toml.translation?.stuck_threshold_ms ??
        DEFAULTS.translation.stuckThresholdMs,
    ),
    systemPrompt:
      toml.translation?.system_prompt ?? DEFAULTS.translation.systemPrompt,
  };

  const telegram: TelegramConfig = {
    pollLeaseMs: Number(
      toml.telegram?.poll_lease_ms ?? DEFAULTS.telegram.pollLeaseMs,
    ),
    chunkChars: Number(
      toml.telegram?.chunk_chars ?? DEFAULTS.telegram.chunkChars,
    ),
    documentFallbackBytes: Number(
      toml.telegram?.document_fallback_bytes ??
        DEFAULTS.telegram.documentFallbackBytes,
    ),
    publicBaseUrl:
      env["BUNNY_PUBLIC_BASE_URL"] ??
      toml.telegram?.public_base_url ??
      DEFAULTS.telegram.publicBaseUrl,
  };

  const code: CodeConfig = {
    cloneTimeoutMs: Number(
      toml.code?.clone_timeout_ms ?? DEFAULTS.code.cloneTimeoutMs,
    ),
    maxRepoSizeMb: Number(
      toml.code?.max_repo_size_mb ?? DEFAULTS.code.maxRepoSizeMb,
    ),
    defaultCloneDepth: Number(
      toml.code?.default_clone_depth ?? DEFAULTS.code.defaultCloneDepth,
    ),
  };

  return {
    llm,
    embed,
    memory,
    render,
    queue,
    auth,
    agent,
    ui,
    web,
    translation,
    telegram,
    code,
    sessionId: env["BUNNY_SESSION"],
  };
}
