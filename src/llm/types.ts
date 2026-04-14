/**
 * Shared LLM types. Modelled on the OpenAI chat-completions API so that the
 * adapter can speak directly to any OpenAI-compatible endpoint.
 */

/** A single turn in the conversation history. */
export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ToolCallFunction {
  name: string;
  /** Serialised JSON args. Accumulated incrementally during streaming. */
  arguments: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: ToolCallFunction;
}

export interface ContentPart {
  type: "text";
  text: string;
}

export interface ChatMessage {
  role: ChatRole;
  content: string | null;
  /** Present only on assistant turns that triggered tools. */
  tool_calls?: ToolCall[];
  /** Present only on `tool` role messages. */
  tool_call_id?: string;
  /** Stored reasoning text (NOT sent back to the LLM; for logging only). */
  reasoning?: string;
  /**
   * Thinking-block signature for Anthropic-compat providers.
   * Must be echoed back in the following request for providers that require it.
   */
  provider_sig?: string;
}

/** JSON-schema subset sufficient for a tool description. */
export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, { type: string; description?: string }>;
  required?: string[];
}

export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: JsonSchemaObject;
  };
}

/** Discriminated channel for every chunk coming out of the stream. */
export type StreamChannel = "content" | "reasoning" | "tool_call" | "usage";

export interface ContentDelta {
  channel: "content";
  index: number;
  text: string;
}

export interface ReasoningDelta {
  channel: "reasoning";
  index: number;
  text: string;
}

export interface ToolCallDelta {
  channel: "tool_call";
  index: number;
  /** Index into the parallel tool-call array. */
  callIndex: number;
  id?: string;
  name?: string;
  /** Partial JSON arguments fragment. */
  argsDelta: string;
}

export interface UsageDelta {
  channel: "usage";
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export type StreamDelta = ContentDelta | ReasoningDelta | ToolCallDelta | UsageDelta;

/** Final accumulated result after the stream closes. */
export interface LlmResponse {
  message: ChatMessage;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  /** Time from first byte to [DONE], milliseconds. */
  durationMs: number;
}

/** Payload for a single chat-completions request. */
export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolSchema[];
  /** If omitted the adapter uses config.llm.model. */
  model?: string;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
}
