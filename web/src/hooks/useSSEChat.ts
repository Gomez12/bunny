import { useCallback, useEffect, useRef, useState } from "react";
import { streamChat, type ChatAttachment, type ServerEvent, type TurnStats } from "../api";

/** Same shape as the default `streamChat` return — lets callers swap in a
 *  different transport (e.g. `/api/code/:id/chat`) without touching the rest
 *  of the chat machinery. */
export type ChatStreamer = (
  body: {
    sessionId: string;
    prompt: string;
    project?: string;
    agent?: string;
    attachments?: ChatAttachment[];
  },
  onEvent: (ev: ServerEvent) => void,
) => { done: Promise<void>; abort: () => void };

/** One rendered turn in the Chat tab (user prompt + assistant streaming output). */
export interface Turn {
  id: string;
  prompt: string;
  attachments: ChatAttachment[];
  content: string;
  reasoning: string;
  toolCalls: ToolCallState[];
  /** Ordered timeline of every reasoning/content/tool/question segment in
   *  arrival order. Drives the visible bubble layout so multi-question
   *  turns don't clump every card at the top. */
  items: TurnItem[];
  /** Displayed stats — wall-clock + token estimate while streaming, frozen
   * to the authoritative server sum once the turn is done. */
  stats: TurnStats | null;
  /** Accumulated from server `stats` events across every LLM call in this turn. */
  serverStats: TurnStats | null;
  /** performance.now() at which the user sent the prompt — used for live timer. */
  startedAt: number;
  /** performance.now() when the most recent ask_user pause started, else null. */
  pausedAtMs: number | null;
  /** Accumulated time spent paused on user questions, subtracted from elapsed. */
  pausedTotalMs: number;
  /** Upstream concurrency-gate state for the most recent LLM call iteration:
   *  - "waiting" — queued behind another in-flight request; timer is paused.
   *  - "active"  — released; the request is in flight (or this turn never queued).
   *  - null      — turn is done, or queue events haven't been observed yet. */
  queueState: "waiting" | "active" | null;
  /** 1-based position when the most recent llm_queue_wait fired (1 = next-up).
   *  0 when not waiting. Drives the "In wachtrij (positie X)" badge. */
  queuePosition: number;
  /** Accumulated queue wait across all LLM-call iterations in this turn. */
  queueWaitTotalMs: number;
  error?: string;
  done: boolean;
  /** Responding agent name. Null = default assistant. Set from SSE events. */
  author: string | null;
  /** Stack of `ask_user` questions emitted during this turn (newest last).
   *  A question stays in the list so prior answers stay visible; only the
   *  last one is currently awaiting input. */
  userQuestions: PendingUserQuestion[];
}

export type TurnItem =
  | { kind: "reasoning"; text: string }
  | { kind: "content"; text: string }
  | { kind: "tool"; tool: ToolCallState }
  | { kind: "question"; question: PendingUserQuestion };

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

export function useSSEChat(
  sessionId: string,
  project: string,
  onTurnComplete?: () => void,
  opts?: { streamer?: ChatStreamer },
) {
  const streamer: ChatStreamer = opts?.streamer ?? streamChat;
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
    (prompt: string, attachments: ChatAttachment[] = [], agent?: string) => {
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
          items: [],
          stats: { durationMs: 0, completionTokens: 0 },
          serverStats: null,
          startedAt,
          pausedAtMs: null,
          pausedTotalMs: 0,
          queueState: null,
          queuePosition: 0,
          queueWaitTotalMs: 0,
          done: false,
          author: agent ?? null,
          userQuestions: [],
        },
      ]);
      setStreaming(true);

      const handler = (ev: ServerEvent) => {
        switch (ev.type) {
          case "content":
            updateLast((t) => {
              const last = t.items[t.items.length - 1];
              const items: TurnItem[] =
                last && last.kind === "content"
                  ? [
                      ...t.items.slice(0, -1),
                      { kind: "content", text: last.text + ev.text },
                    ]
                  : [...t.items, { kind: "content", text: ev.text }];
              return {
                ...t,
                content: t.content + ev.text,
                items,
                author: t.author ?? readAuthor(ev),
              };
            });
            break;
          case "reasoning":
            updateLast((t) => {
              const last = t.items[t.items.length - 1];
              const items: TurnItem[] =
                last && last.kind === "reasoning"
                  ? [
                      ...t.items.slice(0, -1),
                      { kind: "reasoning", text: last.text + ev.text },
                    ]
                  : [...t.items, { kind: "reasoning", text: ev.text }];
              return {
                ...t,
                reasoning: t.reasoning + ev.text,
                items,
                author: t.author ?? readAuthor(ev),
              };
            });
            break;
          case "tool_call": {
            updateLast((t) => {
              const existing = t.toolCalls.find((tc) => tc.callIndex === ev.callIndex);
              if (existing) {
                const updated: ToolCallState = {
                  ...existing,
                  args: existing.args + ev.argsDelta,
                  name: ev.name ?? existing.name,
                };
                return {
                  ...t,
                  toolCalls: t.toolCalls.map((tc) =>
                    tc.callIndex === ev.callIndex ? updated : tc,
                  ),
                  items: t.items.map((it) =>
                    it.kind === "tool" && it.tool.callIndex === ev.callIndex
                      ? { kind: "tool", tool: updated }
                      : it,
                  ),
                };
              }
              const fresh: ToolCallState = {
                callIndex: ev.callIndex,
                name: ev.name ?? "",
                args: ev.argsDelta,
              };
              return {
                ...t,
                toolCalls: [...t.toolCalls, fresh],
                items: [...t.items, { kind: "tool", tool: fresh }],
              };
            });
            break;
          }
          case "tool_result":
            updateLast((t) => {
              const target = t.toolCalls.find(
                (tc) => tc.name === ev.name && tc.ok === undefined,
              );
              if (!target) return t;
              const updated: ToolCallState = {
                ...target,
                ok: ev.ok,
                output: ev.output,
                error: ev.error,
              };
              return {
                ...t,
                toolCalls: t.toolCalls.map((tc) =>
                  tc.callIndex === target.callIndex ? updated : tc,
                ),
                items: t.items.map((it) =>
                  it.kind === "tool" && it.tool.callIndex === target.callIndex
                    ? { kind: "tool", tool: updated }
                    : it,
                ),
              };
            });
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
          case "llm_queue_wait":
            updateLast((t) => ({
              ...t,
              queueState: "waiting",
              queuePosition: ev.position,
            }));
            break;
          case "llm_queue_release":
            updateLast((t) => ({
              ...t,
              queueState: "active",
              queuePosition: 0,
              queueWaitTotalMs: t.queueWaitTotalMs + ev.waitedMs,
            }));
            break;
          case "ask_user_question": {
            const fresh: PendingUserQuestion = {
              questionId: ev.questionId,
              question: ev.question,
              options: ev.options,
              allowCustom: ev.allowCustom,
              multiSelect: ev.multiSelect,
            };
            updateLast((t) => ({
              ...t,
              userQuestions: [...t.userQuestions, fresh],
              items: [...t.items, { kind: "question", question: fresh }],
              author: t.author ?? readAuthor(ev),
            }));
            break;
          }
          case "error":
            updateLast((t) => ({ ...t, error: ev.message }));
            break;
          case "turn_end":
            // Freeze to authoritative server sums once the agent loop is done.
            updateLast((t) => ({
              ...t,
              done: true,
              queueState: null,
              queuePosition: 0,
              stats: t.serverStats ?? t.stats,
            }));
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
      // badge without waiting for the first content delta. The explicit
      // `agent` argument already wins; we only fall back to the parsed
      // mention when the caller didn't supply one.
      if (!agent) {
        const m = prompt.match(/^\s*@([a-z0-9][a-z0-9_-]{0,62})(?:\s+|$)/i);
        if (m) {
          const candidate = m[1]!.toLowerCase();
          updateLast((t) => ({ ...t, author: t.author ?? candidate }));
        }
      }

      const { done, abort } = streamer(
        {
          sessionId,
          prompt,
          project,
          agent,
          attachments: attachments.length > 0 ? attachments : undefined,
        },
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
    [sessionId, project, updateLast, onTurnComplete, streamer],
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
        prev.map((t) => {
          if (t.id !== turnId) return t;
          const updateQ = (q: PendingUserQuestion) =>
            q.questionId === questionId ? { ...q, submittedAnswer: answer } : q;
          return {
            ...t,
            userQuestions: t.userQuestions.map(updateQ),
            items: t.items.map((it) =>
              it.kind === "question" && it.question.questionId === questionId
                ? { kind: "question", question: updateQ(it.question) }
                : it,
            ),
          };
        }),
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

        const awaiting = last.userQuestions.some((q) => !q.submittedAnswer);
        const inQueue = last.queueState === "waiting";
        const shouldPause = awaiting || inQueue;

        if (shouldPause) {
          // Stamp the pause start on the first paused tick. Subsequent paused
          // ticks are no-ops — freezes the displayed value AND avoids burning
          // re-renders at 150ms while the user thinks.
          if (last.pausedAtMs == null) {
            const copy = prev.slice();
            copy[copy.length - 1] = { ...last, pausedAtMs: performance.now() };
            return copy;
          }
          return prev;
        }

        // Resuming after a pause — roll the just-ended pause window into
        // pausedTotalMs so the displayed elapsed continues from where it
        // stopped instead of jumping forward by the wait duration.
        let pausedTotalMs = last.pausedTotalMs;
        let working: Turn = last;
        if (last.pausedAtMs != null) {
          pausedTotalMs += performance.now() - last.pausedAtMs;
          working = { ...last, pausedAtMs: null, pausedTotalMs };
        }

        const elapsed = performance.now() - working.startedAt - pausedTotalMs;
        const approx = approxTokens(working.content);
        const displayed: TurnStats = {
          durationMs: elapsed,
          promptTokens: working.serverStats?.promptTokens,
          completionTokens: Math.max(working.serverStats?.completionTokens ?? 0, approx),
        };
        const copy = prev.slice();
        copy[copy.length - 1] = { ...working, stats: displayed };
        return copy;
      });
    }, 150);
    return () => clearInterval(id);
  }, [streaming]);

  return { turns, streaming, send, abort, reset, markUserQuestionAnswered };
}
