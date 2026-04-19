import { useCallback, useEffect, useRef, useState } from "react";
import { streamChat, type ChatAttachment, type ServerEvent, type TurnStats } from "../api";

/** One rendered turn in the Chat tab (user prompt + assistant streaming output). */
export interface Turn {
  id: string;
  prompt: string;
  attachments: ChatAttachment[];
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
  /** Responding agent name. Null = default assistant. Set from SSE events. */
  author: string | null;
  /** Stack of `ask_user` questions emitted during this turn (newest last).
   *  A question stays in the list so prior answers stay visible; only the
   *  last one is currently awaiting input. */
  userQuestions: PendingUserQuestion[];
}

export interface ToolCallState {
  callIndex: number;
  name: string;
  args: string;
  ok?: boolean;
  output?: string;
  error?: string;
}

/** Active `ask_user` question emitted mid-turn. Cleared once the user submits
 *  (which triggers the corresponding tool_result frame) or the turn ends. */
export interface PendingUserQuestion {
  questionId: string;
  question: string;
  options: string[];
  allowCustom: boolean;
  multiSelect: boolean;
  /** Set once the user has submitted — keeps the card visible in a submitted
   *  state until the tool_result lands. */
  submittedAnswer?: string;
}

// ≈ 4 chars/token is the heuristic OpenAI itself documents for English prose.
const CHARS_PER_TOKEN = 4;

function approxTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.round(text.length / CHARS_PER_TOKEN));
}

export function useSSEChat(sessionId: string, project: string, onTurnComplete?: () => void) {
  type MaybeAuthored = { author?: string };
  const readAuthor = (ev: unknown): string | null => {
    const a = (ev as MaybeAuthored | null)?.author;
    return typeof a === "string" && a ? a : null;
  };
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
    (prompt: string, attachments: ChatAttachment[] = []) => {
      const turnId = crypto.randomUUID();
      const startedAt = performance.now();
      setTurns((prev) => [
        ...prev,
        {
          id: turnId,
          prompt,
          attachments,
          content: "",
          reasoning: "",
          toolCalls: [],
          stats: { durationMs: 0, completionTokens: 0 },
          serverStats: null,
          startedAt,
          done: false,
          author: null,
          userQuestions: [],
        },
      ]);
      setStreaming(true);

      const handler = (ev: ServerEvent) => {
        switch (ev.type) {
          case "content":
            updateLast((t) => ({
              ...t,
              content: t.content + ev.text,
              author: t.author ?? readAuthor(ev),
            }));
            break;
          case "reasoning":
            updateLast((t) => ({
              ...t,
              reasoning: t.reasoning + ev.text,
              author: t.author ?? readAuthor(ev),
            }));
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
          case "ask_user_question":
            updateLast((t) => ({
              ...t,
              userQuestions: [
                ...t.userQuestions,
                {
                  questionId: ev.questionId,
                  question: ev.question,
                  options: ev.options,
                  allowCustom: ev.allowCustom,
                  multiSelect: ev.multiSelect,
                },
              ],
              author: t.author ?? readAuthor(ev),
            }));
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

      // Pre-tag the turn if the user prefixed @name — gives the UI an instant
      // badge without waiting for the first content delta.
      const m = prompt.match(/^\s*@([a-z0-9][a-z0-9_-]{0,62})(?:\s+|$)/i);
      if (m) {
        const candidate = m[1]!.toLowerCase();
        updateLast((t) => ({ ...t, author: t.author ?? candidate }));
      }

      const { done, abort } = streamChat(
        { sessionId, prompt, project, attachments: attachments.length > 0 ? attachments : undefined },
        handler,
      );
      abortRef.current = abort;
      done.catch((e: unknown) => {
        // HTTP-level failure (404/403/etc.): no agent actually answered, so
        // strip the optimistic @-mention badge off the bubble.
        updateLast((t) => ({ ...t, error: String(e), done: true, author: null }));
        setStreaming(false);
        abortRef.current = null;
      });
    },
    [sessionId, project, updateLast, onTurnComplete],
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

  /** Mark a pending user-question as answered so the card flips to a
   *  submitted/read-only state. The matching tool_result SSE frame is what
   *  actually tells the loop to continue streaming. */
  const markUserQuestionAnswered = useCallback(
    (turnId: string, questionId: string, answer: string) => {
      setTurns((prev) =>
        prev.map((t) =>
          t.id === turnId
            ? {
                ...t,
                userQuestions: t.userQuestions.map((q) =>
                  q.questionId === questionId
                    ? { ...q, submittedAnswer: answer }
                    : q,
                ),
              }
            : t,
        ),
      );
    },
    [],
  );

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

  return { turns, streaming, send, abort, reset, markUserQuestionAnswered };
}
