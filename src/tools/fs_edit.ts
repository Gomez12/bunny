/**
 * edit_file tool — replace an exact string in a file.
 *
 * Uses exact-match replacement (like the `Edit` tool in Claude Code). The
 * `old_string` must appear exactly once in the file; otherwise the operation
 * is rejected to avoid silently corrupting files.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, relative } from "node:path";
import type { ToolResult } from "./registry.ts";

function safePath(rawPath: string): string {
  const abs = resolve(process.cwd(), rawPath);
  const rel = relative(process.cwd(), abs);
  if (rel.startsWith("..")) {
    throw new Error(`Path escapes working directory: ${rawPath}`);
  }
  return abs;
}

export function editFileHandler(args: Record<string, unknown>): ToolResult {
  const rawPath = args["path"];
  const oldString = args["old_string"];
  const newString = args["new_string"];

  if (typeof rawPath !== "string" || !rawPath) {
    return { ok: false, output: 'edit_file requires a "path" string argument', error: "missing path" };
  }
  if (typeof oldString !== "string") {
    return { ok: false, output: 'edit_file requires an "old_string" string argument', error: "missing old_string" };
  }
  if (typeof newString !== "string") {
    return { ok: false, output: 'edit_file requires a "new_string" string argument', error: "missing new_string" };
  }

  let abs: string;
  try {
    abs = safePath(rawPath);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, output: msg, error: msg };
  }

  let content: string;
  try {
    content = readFileSync(abs, "utf8");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, output: `Could not read ${rawPath}: ${msg}`, error: msg };
  }

  const count = content.split(oldString).length - 1;
  if (count === 0) {
    return {
      ok: false,
      output: `old_string not found in ${rawPath}. No changes made.`,
      error: "old_string not found",
    };
  }
  if (count > 1) {
    return {
      ok: false,
      output: `old_string appears ${count} times in ${rawPath}. Provide more context to make it unique.`,
      error: "old_string not unique",
    };
  }

  const updated = content.replace(oldString, newString);
  try {
    writeFileSync(abs, updated, "utf8");
    return { ok: true, output: `Successfully edited ${rawPath}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, output: `Could not write ${rawPath}: ${msg}`, error: msg };
  }
}

export const EDIT_FILE_SCHEMA = {
  type: "object" as const,
  properties: {
    path: { type: "string", description: "Path to the file to edit, relative to working directory." },
    old_string: { type: "string", description: "Exact string to replace. Must appear exactly once in the file." },
    new_string: { type: "string", description: "Replacement string." },
  },
  required: ["path", "old_string", "new_string"],
};
