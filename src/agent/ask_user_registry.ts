/**
 * In-memory registry of pending user questions.
 *
 * The `ask_user` tool blocks on a promise registered here. When the user
 * submits an answer via `POST /api/sessions/:sessionId/questions/:questionId/
 * answer`, `answerPendingQuestion` resolves that promise and the tool handler
 * returns the answer as its tool_result.
 *
 * Scope is per-process only: on server restart every in-flight question is
 * dropped and the waiting tool rejects with a timeout, so a user that
 * refreshes mid-question needs to re-ask. The tool_call row stays in the DB
 * but never gets a matching tool_result — which is fine, the loop treats the
 * turn as completed with an error.
 */

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

interface PendingEntry {
  resolve(answer: string): void;
  reject(reason: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingEntry>();

function keyOf(sessionId: string, questionId: string): string {
  return `${sessionId}::${questionId}`;
}

/**
 * Register a pending question and return a promise that resolves with the
 * user's answer (or rejects on timeout / cancellation). The caller is
 * responsible for emitting the SSE event that tells the UI to render.
 */
export function waitForAnswer(
  sessionId: string,
  questionId: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<string> {
  const key = keyOf(sessionId, questionId);
  if (pending.has(key)) {
    return Promise.reject(
      new Error(`ask_user: duplicate questionId '${questionId}'`),
    );
  }
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(key);
      reject(new Error("ask_user: timed out waiting for user answer"));
    }, timeoutMs);
    pending.set(key, { resolve, reject, timer });
  });
}

/**
 * Resolve a pending question with the user's answer. Returns `true` if a
 * waiter was found (and the promise was resolved), `false` otherwise — let
 * the caller translate to a 404 so the UI knows the question is stale.
 */
export function answerPendingQuestion(
  sessionId: string,
  questionId: string,
  answer: string,
): boolean {
  const key = keyOf(sessionId, questionId);
  const entry = pending.get(key);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pending.delete(key);
  entry.resolve(answer);
  return true;
}

/**
 * Cancel a pending question (e.g. turn aborted). Rejects the waiter. Returns
 * `true` if something was cancelled, `false` if no waiter existed.
 */
export function cancelPendingQuestion(
  sessionId: string,
  questionId: string,
  reason = "ask_user: cancelled",
): boolean {
  const key = keyOf(sessionId, questionId);
  const entry = pending.get(key);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pending.delete(key);
  entry.reject(new Error(reason));
  return true;
}

/**
 * Cancel every pending question for one session. Returns the number of
 * waiters rejected. Used by subsystems (like workflow cancellation) that
 * need to unblock in-flight `waitForAnswer` calls immediately instead of
 * waiting for the 15-minute timeout.
 */
export function cancelPendingQuestionsForSession(
  sessionId: string,
  reason = "ask_user: session cancelled",
): number {
  const prefix = `${sessionId}::`;
  let cancelled = 0;
  for (const [key, entry] of pending.entries()) {
    if (!key.startsWith(prefix)) continue;
    clearTimeout(entry.timer);
    pending.delete(key);
    entry.reject(new Error(reason));
    cancelled++;
  }
  return cancelled;
}

/** Testing helper — drop every pending waiter. */
export function __resetPendingQuestionsForTests(): void {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(new Error("test reset"));
  }
  pending.clear();
}

export function __pendingCountForTests(): number {
  return pending.size;
}
