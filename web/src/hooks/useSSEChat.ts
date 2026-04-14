import { useCallback, useEffect, useRef, useState } from "react";
import { streamChat, type ServerEvent } from "../api";

/** One rendered turn in the Chat tab (user prompt + assistant streaming output). */
export interface Turn {
  id: string;
  prompt: string;
  content: string;
  reasoning: string;
  toolCalls: ToolCallState[];
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
      setTurns((prev) => [
        ...prev,
        { id: turnId, prompt, content: "", reasoning: "", toolCalls: [], done: false },
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
          case "error":
            updateLast((t) => ({ ...t, error: ev.message }));
            break;
          case "turn_end":
            updateLast((t) => ({ ...t, done: true }));
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

  // Abort any in-flight stream when the component unmounts — otherwise the
  // fetch reader keeps delivering events and calls setTurns on an unmounted
  // tree.
  useEffect(() => () => abortRef.current?.(), []);

  return { turns, streaming, send, abort, reset };
}
