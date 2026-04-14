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
  channel: "content" | "reasoning" | "tool_result";
  content: string | null;
  toolCallId: string | null;
  toolName: string | null;
  providerSig: string | null;
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
