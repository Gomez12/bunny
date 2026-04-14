import { isAbsolute, join, relative, resolve } from "node:path";

/**
 * Resolve `rawPath` relative to `cwd` and throw if it escapes the working
 * directory (path traversal guard).
 */
export function safePath(rawPath: string, cwd = process.cwd()): string {
  const abs = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
  const rel = relative(cwd, abs);
  if (rel.startsWith("..")) {
    throw new Error(`Path escapes working directory: ${rawPath}`);
  }
  return abs;
}
