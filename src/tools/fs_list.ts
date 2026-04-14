/**
 * list_dir tool — list the entries of a directory.
 *
 * Returns a newline-separated list of entry names (with a trailing `/` for
 * directories). Hidden files (starting with `.`) are listed when
 * `show_hidden` is true.
 */

import { readdirSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import type { ToolResult } from "./registry.ts";

function safePath(rawPath: string): string {
  const abs = resolve(process.cwd(), rawPath);
  const rel = relative(process.cwd(), abs);
  if (rel.startsWith("..")) {
    throw new Error(`Path escapes working directory: ${rawPath}`);
  }
  return abs;
}

export function listDirHandler(args: Record<string, unknown>): ToolResult {
  const rawPath = (args["path"] as string | undefined) ?? ".";
  const showHidden = args["show_hidden"] === true;

  let abs: string;
  try {
    abs = safePath(rawPath);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, output: msg, error: msg };
  }

  try {
    const entries = readdirSync(abs);
    const lines = entries
      .filter((e) => showHidden || !e.startsWith("."))
      .map((e) => {
        try {
          const isDir = statSync(join(abs, e)).isDirectory();
          return isDir ? e + "/" : e;
        } catch {
          return e;
        }
      });
    return { ok: true, output: lines.length > 0 ? lines.join("\n") : "(empty directory)" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, output: msg, error: msg };
  }
}

export const LIST_DIR_SCHEMA = {
  type: "object" as const,
  properties: {
    path: { type: "string", description: "Directory path relative to working directory. Defaults to '.'." },
    show_hidden: { type: "boolean", description: "Include hidden files (starting with '.'). Default false." },
  },
  required: [],
};
