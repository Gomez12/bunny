/** Shared types and fetch helpers for the Bunny API. */

import type { SseEvent } from "../../src/agent/sse_events";

export type ServerEvent = SseEvent;

export interface SessionSummary {
  sessionId: string;
  title: string;
  firstTs: number;
  lastTs: number;
  messageCount: number;
}

export interface StoredMessage {
  id: number;
  sessionId: string;
  ts: number;
  role: "system" | "user" | "assistant" | "tool";
  channel: "content" | "reasoning" | "tool_call" | "tool_result";
  content: string | null;
  toolCallId: string | null;
  toolName: string | null;
  providerSig: string | null;
  ok: boolean | null;
  durationMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
}

export interface TurnStats {
  durationMs: number;
  promptTokens?: number;
  completionTokens?: number;
}

/**
 * Older turns were persisted as [content, reasoning]; newer turns as
 * [reasoning, content]. Swap any legacy pair so the thinking block always
 * renders above its answer.
 */
export function reorderReasoning(messages: StoredMessage[]): StoredMessage[] {
  const out = messages.slice();
  for (let i = 0; i < out.length - 1; i++) {
    const a = out[i]!;
    const b = out[i + 1]!;
    if (
      a.role === "assistant" &&
      b.role === "assistant" &&
      a.channel === "content" &&
      b.channel === "reasoning"
    ) {
      out[i] = b;
      out[i + 1] = a;
    }
  }
  return out;
}

/** One assistant turn reconstructed from stored rows — matches the shape that
 * `useSSEChat` produces for live streaming, so history and live conversation
 * render identically. */
export interface HistoryTurn {
  id: string;
  prompt: string;
  reasoning: string;
  content: string;
  toolCalls: Array<{
    id: string;
    name: string;
    args: string;
    output?: string;
    ok?: boolean;
  }>;
  /** Aggregated over every LLM call inside this user turn. */
  stats: TurnStats | null;
}

/** Group rows into turns: every user message opens a new turn and all following
 * assistant/tool rows fold into it until the next user message. Tool_call and
 * tool_result rows are paired by tool_call_id so a reloaded conversation shows
 * the same {args + output + ok} card as a live one. */
export function groupTurns(messages: StoredMessage[]): HistoryTurn[] {
  const turns: HistoryTurn[] = [];
  let current: HistoryTurn | null = null;

  for (const m of messages) {
    if (m.role === "user") {
      current = {
        id: `turn-${m.id}`,
        prompt: m.content ?? "",
        reasoning: "",
        content: "",
        toolCalls: [],
        stats: null,
      };
      turns.push(current);
      continue;
    }
    if (!current) continue;

    if (m.role === "assistant" && m.channel === "reasoning") {
      current.reasoning += (current.reasoning ? "\n\n" : "") + (m.content ?? "");
    } else if (m.role === "assistant" && m.channel === "content") {
      current.content += (current.content ? "\n\n" : "") + (m.content ?? "");
      if (m.durationMs != null) {
        current.stats = {
          durationMs: (current.stats?.durationMs ?? 0) + m.durationMs,
          promptTokens: (current.stats?.promptTokens ?? 0) + (m.promptTokens ?? 0),
          completionTokens: (current.stats?.completionTokens ?? 0) + (m.completionTokens ?? 0),
        };
      }
    } else if (m.role === "assistant" && m.channel === "tool_call") {
      current.toolCalls.push({
        id: m.toolCallId ?? `anon-${m.id}`,
        name: m.toolName ?? "tool",
        args: m.content ?? "",
      });
    } else if (m.role === "tool" && m.channel === "tool_result") {
      const match = m.toolCallId
        ? current.toolCalls.find((tc) => tc.id === m.toolCallId)
        : undefined;
      if (match) {
        match.output = m.content ?? "";
        match.ok = m.ok ?? true;
      } else {
        // Legacy row (tool_call not persisted) — synthesise a card with just the result.
        current.toolCalls.push({
          id: m.toolCallId ?? `anon-${m.id}`,
          name: m.toolName ?? "tool",
          args: "",
          output: m.content ?? "",
          ok: m.ok ?? true,
        });
      }
    }
  }
  return turns;
}

export async function fetchSessions(search?: string): Promise<SessionSummary[]> {
  const url = search ? `/api/sessions?q=${encodeURIComponent(search)}` : "/api/sessions";
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  const data = (await res.json()) as { sessions: SessionSummary[] };
  return data.sessions;
}

export async function fetchMessages(sessionId: string): Promise<StoredMessage[]> {
  const url = `/api/sessions/${encodeURIComponent(sessionId)}/messages`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  const data = (await res.json()) as { messages: StoredMessage[] };
  return data.messages;
}

export async function createSession(): Promise<string> {
  const res = await fetch("/api/sessions", { method: "POST" });
  if (!res.ok) throw new Error(`POST /api/sessions → ${res.status}`);
  const data = (await res.json()) as { sessionId: string };
  return data.sessionId;
}

/**
 * Open an SSE chat stream. Calls `onEvent` for every parsed JSON payload.
 * Returns a promise that resolves when the stream ends and an abort function.
 */
export function streamChat(
  body: { sessionId: string; prompt: string },
  onEvent: (ev: ServerEvent) => void,
): { done: Promise<void>; abort: () => void } {
  const controller = new AbortController();

  const done = (async () => {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok || !res.body) {
      throw new Error(`POST /api/chat → ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      // SSE frames separated by "\n\n".
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          try {
            onEvent(JSON.parse(payload) as ServerEvent);
          } catch {
            // Skip malformed frames rather than killing the stream.
          }
        }
      }
    }
  })();

  return { done, abort: () => controller.abort() };
}
