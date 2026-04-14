import { useCallback, useEffect, useRef, useState } from "react";
import { streamChat, type ServerEvent, type TurnStats } from "../api";

/** One rendered turn in the Chat tab (user prompt + assistant streaming output). */
export interface Turn {
  id: string;
  prompt: string;
  content: string;
  reasoning: string;
  toolCalls: ToolCallState[];
  /** Displayed stats — wall-clock + token estimate while streaming, frozen
   * to the authoritative server sum once the turn is done. */
  stats: TurnStats | null;
  /** Accumulated from server `stats` events across every LLM call in this turn. */
  serverStats: TurnStats | null;
  /** performance.now() at which the user sent the prompt — used for live timer. */
  startedAt: number;
  error?: string;
  done: boolean;
}

export interface ToolCallState {
  callIndex: number;
  name: string;
  args: string;
  ok?: boolean;
  output?: string;
  error?: string;
}

// ≈ 4 chars/token is the heuristic OpenAI itself documents for English prose.
const CHARS_PER_TOKEN = 4;

function approxTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.round(text.length / CHARS_PER_TOKEN));
}

export function useSSEChat(sessionId: string, onTurnComplete?: () => void) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<(() => void) | null>(null);

  const updateLast = useCallback((updater: (t: Turn) => Turn) => {
    setTurns((prev) => {
      if (prev.length === 0) return prev;
      const copy = prev.slice();
      copy[copy.length - 1] = updater(copy[copy.length - 1]!);
      return copy;
    });
  }, []);

  const send = useCallback(
    (prompt: string) => {
      const turnId = crypto.randomUUID();
      const startedAt = performance.now();
      setTurns((prev) => [
        ...prev,
        {
          id: turnId,
          prompt,
          content: "",
          reasoning: "",
          toolCalls: [],
          stats: { durationMs: 0, completionTokens: 0 },
          serverStats: null,
          startedAt,
          done: false,
        },
      ]);
      setStreaming(true);

      const handler = (ev: ServerEvent) => {
        switch (ev.type) {
          case "content":
            updateLast((t) => ({ ...t, content: t.content + ev.text }));
            break;
          case "reasoning":
            updateLast((t) => ({ ...t, reasoning: t.reasoning + ev.text }));
            break;
          case "tool_call": {
            updateLast((t) => {
              const existing = t.toolCalls.find((tc) => tc.callIndex === ev.callIndex);
              if (existing) {
                return {
                  ...t,
                  toolCalls: t.toolCalls.map((tc) =>
                    tc.callIndex === ev.callIndex
                      ? { ...tc, args: tc.args + ev.argsDelta, name: ev.name ?? tc.name }
                      : tc,
                  ),
                };
              }
              return {
                ...t,
                toolCalls: [
                  ...t.toolCalls,
                  { callIndex: ev.callIndex, name: ev.name ?? "", args: ev.argsDelta },
                ],
              };
            });
            break;
          }
          case "tool_result":
            updateLast((t) => ({
              ...t,
              toolCalls: t.toolCalls.map((tc) =>
                tc.name === ev.name && tc.ok === undefined
                  ? { ...tc, ok: ev.ok, output: ev.output, error: ev.error }
                  : tc,
              ),
            }));
            break;
          case "stats":
            updateLast((t) => {
              const summed: TurnStats = {
                durationMs: (t.serverStats?.durationMs ?? 0) + ev.durationMs,
                promptTokens:
                  (t.serverStats?.promptTokens ?? 0) + (ev.promptTokens ?? 0),
                completionTokens:
                  (t.serverStats?.completionTokens ?? 0) + (ev.completionTokens ?? 0),
              };
              return { ...t, serverStats: summed };
            });
            break;
          case "error":
            updateLast((t) => ({ ...t, error: ev.message }));
            break;
          case "turn_end":
            // Freeze to authoritative server sums once the agent loop is done.
            updateLast((t) => ({ ...t, done: true, stats: t.serverStats ?? t.stats }));
            break;
          case "done":
            setStreaming(false);
            abortRef.current = null;
            onTurnComplete?.();
            break;
          case "usage":
            break;
        }
      };

      const { done, abort } = streamChat({ sessionId, prompt }, handler);
      abortRef.current = abort;
      done.catch((e: unknown) => {
        updateLast((t) => ({ ...t, error: String(e), done: true }));
        setStreaming(false);
        abortRef.current = null;
      });
    },
    [sessionId, updateLast, onTurnComplete],
  );

  const abort = useCallback(() => {
    abortRef.current?.();
    abortRef.current = null;
    setStreaming(false);
    updateLast((t) => ({ ...t, done: true }));
  }, [updateLast]);

  const reset = useCallback(() => {
    abortRef.current?.();
    abortRef.current = null;
    setTurns([]);
    setStreaming(false);
  }, []);

  useEffect(() => () => abortRef.current?.(), []);

  // While streaming, tick every 150ms and update the current turn's displayed
  // stats: wall-clock elapsed + best-effort completion token count. Server
  // stats events overwrite the token estimate with authoritative numbers
  // between LLM calls; turn_end freezes onto those values.
  useEffect(() => {
    if (!streaming) return;
    const id = window.setInterval(() => {
      setTurns((prev) => {
        if (prev.length === 0) return prev;
        const last = prev[prev.length - 1]!;
        if (last.done) return prev;
        const elapsed = performance.now() - last.startedAt;
        const approx = approxTokens(last.content);
        const displayed: TurnStats = {
          durationMs: elapsed,
          promptTokens: last.serverStats?.promptTokens,
          completionTokens: Math.max(last.serverStats?.completionTokens ?? 0, approx),
        };
        const copy = prev.slice();
        copy[copy.length - 1] = { ...last, stats: displayed };
        return copy;
      });
    }, 150);
    return () => clearInterval(id);
  }, [streaming]);

  return { turns, streaming, send, abort, reset };
}
