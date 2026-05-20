/**
 * Error helpers.
 *
 * Two functions:
 *
 *   - `errorMessage(e)` — response-safe. Returns `INTERNAL_ERROR_MESSAGE`
 *     for any unknown `Error`, so the raw `Error.message` (a CodeQL taint
 *     source for `js/stack-trace-exposure`) cannot leak into a JSON
 *     response body. Only the `safeMessage` of a `SafeError` instance is
 *     forwarded — those are messages a domain module explicitly authored
 *     for the user. This is the function HTTP route catches must use.
 *
 *   - `errorDetails(e)` — diagnostic. Returns the first line of the raw
 *     error message, capped to a reasonable length and with the leading
 *     class-name prefix (`Error: `, `TypeError: `, …) stripped. Intended
 *     for log lines, queue payloads, DB error columns, stderr, and tool
 *     plumbing. Never use this where the value flows back to an HTTP
 *     client.
 *
 * Plus a typed marker `SafeError` that callers throw when they want the
 * message to reach the user, and a `logUnexpectedError(queue, e, ctx)`
 * helper so masked errors still produce a diagnostic trail in the
 * bunqueue event log.
 */

const MAX_ERROR_MESSAGE_LEN = 200;

/**
 * Constant returned by {@link errorMessage} for any thrown value that is
 * not a {@link SafeError}. Exported so call-sites and tests can compare
 * against the same string.
 */
export const INTERNAL_ERROR_MESSAGE = "Internal error";

/**
 * Error subclass whose `safeMessage` may be returned verbatim in HTTP
 * response bodies. Throw this from validators and route handlers when
 * the message is authored for the user (e.g. `"missing project"`,
 * `"forbidden"`, `"out of range"`).
 *
 * Use a plain `Error` for unexpected failures (DB errors, IO errors,
 * upstream LLM failures, etc.) — those will be masked by
 * {@link errorMessage}.
 */
export class SafeError extends Error {
  readonly safeMessage: string;
  readonly httpStatus?: number;

  constructor(
    safeMessage: string,
    opts?: { httpStatus?: number; cause?: unknown },
  ) {
    super(safeMessage, opts?.cause !== undefined ? { cause: opts.cause } : {});
    this.name = "SafeError";
    this.safeMessage = safeMessage;
    if (opts?.httpStatus !== undefined) this.httpStatus = opts.httpStatus;
  }
}

/**
 * Return a diagnostic representation of any thrown value. First line
 * only, leading class-name prefix stripped, capped to
 * {@link MAX_ERROR_MESSAGE_LEN}. Safe to put in logs / DB columns /
 * stderr but **not** safe to put in HTTP responses — use
 * {@link errorMessage} for that.
 */
export function errorDetails(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const firstLine = raw.split("\n", 1)[0] ?? "";
  const withoutPrefix = firstLine.replace(/^[A-Z][A-Za-z0-9_$]*Error:\s*/, "");
  return withoutPrefix.slice(0, MAX_ERROR_MESSAGE_LEN);
}

/**
 * Return a response-safe message for any thrown value.
 *
 * - `SafeError` → its `safeMessage`, still first-line + length-capped as
 *   belt-and-braces in case a caller passed a multi-line string by
 *   mistake.
 * - any other `Error` → {@link INTERNAL_ERROR_MESSAGE}. The real
 *   `.message` is dropped on the floor here; callers that want
 *   diagnostics must log them separately (see
 *   {@link logUnexpectedError}).
 * - non-`Error` values (string, number, null, undefined, …) →
 *   `String(e)` first-line, capped, same as
 *   {@link errorDetails}. Throwing non-`Error` values is rare and
 *   usually a bug, so we don't try to be clever about hiding the value.
 */
export function errorMessage(e: unknown): string {
  if (e instanceof SafeError) {
    const firstLine = e.safeMessage.split("\n", 1)[0] ?? "";
    return firstLine.slice(0, MAX_ERROR_MESSAGE_LEN);
  }
  if (e instanceof Error) return INTERNAL_ERROR_MESSAGE;
  return errorDetails(e);
}

/**
 * Map an error to its HTTP response status. Returns the
 * `httpStatus` carried by a {@link SafeError} (if any), or `fallback`
 * (default 500) for anything else. Pair with {@link errorMessage} in
 * route catch blocks:
 *
 * ```ts
 * } catch (e) {
 *   logUnexpectedError(ctx.queue, e, "POST /foo");
 *   return json({ error: errorMessage(e) }, errorStatus(e, 400));
 * }
 * ```
 */
export function errorStatus(e: unknown, fallback = 500): number {
  if (e instanceof SafeError && typeof e.httpStatus === "number") {
    return e.httpStatus;
  }
  return fallback;
}

/**
 * Minimal subset of {@link BunnyQueue} we need for warn-level logging.
 * Typed here as a local interface so this module stays free of a
 * dependency on `src/queue/bunqueue.ts` (and the SQLite types it pulls
 * in).
 */
export interface LogCapableQueue {
  log(payload: {
    topic: string;
    kind: string;
    sessionId?: string;
    userId?: string;
    data?: unknown;
    error?: string;
  }): Promise<void>;
}

/**
 * Push a warn-level event to the queue describing an unexpected error
 * whose message was about to be masked by {@link errorMessage}. The
 * diagnostic line is still captured for the operator — only the
 * client-facing channel is sanitised.
 *
 * Fire-and-forget: callers should `void`-prefix the call inside catch
 * blocks, the same pattern other queue.log uses in `src/server/**`.
 *
 * SafeError instances are not logged — by definition their message is
 * already user-facing and there is no diagnostic information at risk.
 * Non-`Error` values are still logged (an unusual throw is itself a
 * signal).
 */
export function logUnexpectedError(
  queue: LogCapableQueue | undefined,
  e: unknown,
  context: string,
): void {
  if (e instanceof SafeError) return;
  if (!queue) return;
  void queue.log({
    topic: "error",
    kind: "unexpected",
    data: { context },
    error: errorDetails(e),
  });
}
