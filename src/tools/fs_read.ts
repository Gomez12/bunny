/**
 * read_file tool — read the contents of a file.
 *
 * The path is resolved relative to `process.cwd()`, never to an absolute
 * system path, to keep the agent scoped to the project directory.
 */

import { readFileSync } from "node:fs";
import { safePath } from "../util/path.ts";
import { errorMessage } from "../util/error.ts";
import type { ToolResult } from "./registry.ts";

const MAX_BYTES = 200_000; // ~200 KB — reasonable LLM context budget

export function readFileHandler(args: Record<string, unknown>): ToolResult {
  const rawPath = args["path"];
  if (typeof rawPath !== "string" || !rawPath) {
    return { ok: false, output: 'read_file requires a "path" string argument', error: "missing path" };
  }

  let abs: string;
  try {
    abs = safePath(rawPath);
  } catch (e) {
    const msg = errorMessage(e);
    return { ok: false, output: msg, error: msg };
  }

  try {
    const buf = readFileSync(abs);
    if (buf.length > MAX_BYTES) {
      const preview = buf.slice(0, MAX_BYTES).toString("utf8");
      return {
        ok: true,
        output: preview + `\n\n[truncated: file is ${buf.length} bytes, showing first ${MAX_BYTES}]`,
      };
    }
    return { ok: true, output: buf.toString("utf8") };
  } catch (e) {
    const msg = errorMessage(e);
    return { ok: false, output: msg, error: msg };
  }
}

export const READ_FILE_SCHEMA = {
  type: "object" as const,
  properties: {
    path: { type: "string", description: "Path to the file, relative to the working directory." },
  },
  required: ["path"],
};
