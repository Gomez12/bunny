/**
 * Minimal structured logger.
 *
 * Writes JSON lines to stderr (so stdout stays clean for agent output).
 * In non-TTY mode this is the primary observability channel.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_NUM: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let _minLevel: LogLevel = (process.env["LOG_LEVEL"] as LogLevel | undefined) ?? "info";

export function setLogLevel(level: LogLevel): void {
  _minLevel = level;
}

function emit(level: LogLevel, msg: string, data?: unknown): void {
  if (LEVEL_NUM[level] < LEVEL_NUM[_minLevel]) return;
  const line = JSON.stringify({ ts: Date.now(), level, msg, ...(data ? { data } : {}) });
  process.stderr.write(line + "\n");
}

export function truncate(s: string, max = 500): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

export const log = {
  debug: (msg: string, data?: unknown) => emit("debug", msg, data),
  info: (msg: string, data?: unknown) => emit("info", msg, data),
  warn: (msg: string, data?: unknown) => emit("warn", msg, data),
  error: (msg: string, data?: unknown) => emit("error", msg, data),
};
