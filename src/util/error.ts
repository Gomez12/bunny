const MAX_ERROR_MESSAGE_LEN = 200;

/**
 * Extract a human-readable, response-safe message from an unknown thrown
 * value. The return is intended for JSON error responses, so we deliberately
 * drop multi-line content (most stack traces are multi-line) and cap the
 * length to keep accidental dumps of internal state out of the wire. The
 * full error — including its stack — must be logged separately by callers
 * when diagnostics matter.
 */
export function errorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const firstLine = raw.split("\n", 1)[0] ?? "";
  // Strip leading `Error: ` / `TypeError: ` so the class name never leaks.
  const withoutPrefix = firstLine.replace(/^[A-Z][A-Za-z0-9_$]*Error:\s*/, "");
  return withoutPrefix.slice(0, MAX_ERROR_MESSAGE_LEN);
}
