/**
 * Shared type contract for SSE events emitted by the agent and consumed by
 * the web UI. Imported by both `src/agent/render_sse.ts` (backend) and
 * `web/src/api.ts` (frontend) so adding a new event type is a compile error
 * on both sides instead of silent drift.
 *
 * Wire format: each event is one `data: {json}\n\n` frame.
 */

export interface SseContentEvent {
  type: "content";
  text: string;
}

export interface SseReasoningEvent {
  type: "reasoning";
  text: string;
}

export interface SseToolCallEvent {
  type: "tool_call";
  name?: string;
  id?: string;
  argsDelta: string;
  callIndex: number;
}

export interface SseToolResultEvent {
  type: "tool_result";
  name: string;
  ok: boolean;
  output: string;
  error?: string;
}

export interface SseUsageEvent {
  type: "usage";
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface SseStatsEvent {
  type: "stats";
  durationMs: number;
  promptTokens?: number;
  completionTokens?: number;
}

export interface SseErrorEvent {
  type: "error";
  message: string;
}

export interface SseTurnEndEvent {
  type: "turn_end";
}

export interface SseDoneEvent {
  type: "done";
}

export type SseEvent =
  | SseContentEvent
  | SseReasoningEvent
  | SseToolCallEvent
  | SseToolResultEvent
  | SseUsageEvent
  | SseStatsEvent
  | SseErrorEvent
  | SseTurnEndEvent
  | SseDoneEvent;
