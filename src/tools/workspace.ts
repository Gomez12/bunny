/**
 * Workspace tools — closure-bound read/write access to a project's on-disk
 * workspace directory (`<projectDir>/workspace`).
 *
 * Same pattern as {@link ./board.ts}: the project name is baked into the
 * closure so an agent in project "alpha" cannot reach project "beta".
 * Path traversal is caught inside every helper by
 * {@link ../memory/workspace_fs.ts:safeWorkspacePath}.
 *
 * Read output is size-capped so a wayward `read_workspace_file` can't
 * blow up the LLM context. The UI download route bypasses this cap.
 */

import type { ToolDescriptor } from "./registry.ts";
import { toolOk, toolErr, getString } from "./registry.ts";
import { errorMessage } from "../util/error.ts";
import {
  listWorkspace,
  readWorkspaceFile,
  writeWorkspaceFile,
} from "../memory/workspace_fs.ts";

export const WORKSPACE_TOOL_NAMES = [
  "list_workspace_files",
  "read_workspace_file",
  "write_workspace_file",
] as const;
export type WorkspaceToolName = (typeof WORKSPACE_TOOL_NAMES)[number];

export interface WorkspaceToolContext {
  project: string;
}

/** Cap on bytes returned to the LLM from a single read, per encoding. */
const MAX_UTF8_BYTES = 64 * 1024;
const MAX_BASE64_BYTES = 5 * 1024 * 1024;

export function makeWorkspaceTools(ctx: WorkspaceToolContext): ToolDescriptor[] {
  return [listTool(ctx), readTool(ctx), writeTool(ctx)];
}

function listTool(ctx: WorkspaceToolContext): ToolDescriptor {
  return {
    name: "list_workspace_files",
    description:
      "List files and subdirectories inside the project's workspace. Pass 'path' to descend into a subdirectory (e.g. 'input' or 'output/reports'). Omit to list the workspace root.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Workspace-relative directory path (forward slashes). Empty / omitted = workspace root.",
        },
      },
    },
    handler: (args) => {
      try {
        const entries = listWorkspace(ctx.project, getString(args, "path") ?? "");
        return toolOk({ path: getString(args, "path") ?? "", entries });
      } catch (e) {
        return toolErr(errorMessage(e));
      }
    },
  };
}

function readTool(ctx: WorkspaceToolContext): ToolDescriptor {
  return {
    name: "read_workspace_file",
    description:
      "Read a file from the project's workspace. Defaults to UTF-8 text; use encoding='base64' for binary files (images, PDFs). Large files are truncated — inspect 'truncated' / 'totalBytes' in the response.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative file path (e.g. 'input/notes.md').",
        },
        encoding: {
          type: "string",
          description:
            "'utf8' (default) returns text; 'base64' returns bytes for binary files.",
        },
      },
      required: ["path"],
    },
    handler: (args) => {
      const path = getString(args, "path");
      if (!path) return toolErr("missing 'path'");
      const enc = getString(args, "encoding") === "base64" ? "base64" : "utf8";
      const cap = enc === "base64" ? MAX_BASE64_BYTES : MAX_UTF8_BYTES;
      try {
        return toolOk(readWorkspaceFile(ctx.project, path, enc, cap));
      } catch (e) {
        return toolErr(errorMessage(e));
      }
    },
  };
}

function writeTool(ctx: WorkspaceToolContext): ToolDescriptor {
  return {
    name: "write_workspace_file",
    description:
      "Create or overwrite a file inside the project's workspace. Missing parent directories are created automatically. Use encoding='base64' for binary content.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Workspace-relative file path (e.g. 'output/summary.md'). Must not escape the workspace.",
        },
        content: {
          type: "string",
          description:
            "File content. UTF-8 text by default; base64-encoded bytes when encoding='base64'.",
        },
        encoding: {
          type: "string",
          description:
            "How 'content' is encoded: 'utf8' (default) or 'base64' for binary.",
        },
      },
      required: ["path", "content"],
    },
    handler: (args) => {
      const path = getString(args, "path");
      const content = getString(args, "content");
      if (!path) return toolErr("missing 'path'");
      if (content === undefined) return toolErr("missing 'content'");
      const enc = getString(args, "encoding") === "base64" ? "base64" : "utf8";
      try {
        return toolOk(writeWorkspaceFile(ctx.project, path, content, enc));
      } catch (e) {
        return toolErr(errorMessage(e));
      }
    },
  };
}
