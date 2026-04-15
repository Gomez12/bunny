/**
 * File-system helpers for per-project workspaces.
 *
 * Every entry path is **relative** to the workspace root
 * (`<projectDir>/workspace`). All public helpers resolve through
 * {@link safeWorkspacePath}, which throws on any traversal attempt
 * (`..`, absolute path, symlink escaping root). Callers may therefore
 * pass user-supplied paths directly — but must catch the error and map
 * it to a 4xx.
 *
 * Pure filesystem layer: no db, no HTTP, no auth. Route handlers own
 * the permission checks and status-code mapping.
 */

import {
  mkdirSync,
  readdirSync,
  statSync,
  existsSync,
  readFileSync,
  writeFileSync,
  rmSync,
  renameSync,
  realpathSync,
} from "node:fs";
import { join, dirname, posix, relative, resolve } from "node:path";
import { workspaceDir, WORKSPACE_DEFAULT_SUBDIRS } from "./project_assets.ts";
import { ensureProjectDir } from "./project_assets.ts";

export interface WorkspaceEntry {
  name: string;
  /** POSIX path relative to the workspace root (forward slashes). */
  path: string;
  kind: "file" | "dir";
  size: number;
  mtime: number;
}

const PROTECTED_ROOTS: ReadonlySet<string> = new Set(WORKSPACE_DEFAULT_SUBDIRS);

/**
 * Resolve a workspace-relative path to an absolute path. Throws if the
 * result escapes the workspace root. The workspace directory itself is
 * created on the fly if missing so callers don't have to pre-seed it.
 */
export function safeWorkspacePath(project: string, relPath: string): {
  abs: string;
  root: string;
  rel: string;
} {
  const root = workspaceDir(project);
  // Ensure the root exists before any I/O (legacy projects are backfilled).
  ensureProjectDir(project);

  const cleaned = normaliseRel(relPath);
  const abs = resolve(root, cleaned);
  const relFromRoot = relative(root, abs);
  if (relFromRoot.startsWith("..") || resolve(root, relFromRoot) !== abs) {
    throw new Error(`path escapes workspace: ${relPath}`);
  }
  return { abs, root, rel: cleaned };
}

/** Normalise "", "/", "./a/b", "a\\b" → "a/b" (POSIX, no leading slash). */
function normaliseRel(raw: string): string {
  if (!raw || raw === "/" || raw === ".") return "";
  const posixed = raw.replace(/\\/g, "/").replace(/^\/+/, "");
  // `posix.normalize` collapses `.` and `..`; the safePath check above still
  // guards escapes, but normalising here keeps listings/links tidy.
  const norm = posix.normalize(posixed);
  return norm === "." ? "" : norm;
}

function assertNotProtected(rel: string): void {
  if (rel === "") throw new Error("cannot modify the workspace root");
  const top = rel.split("/")[0]!;
  // Only the top-level default dirs themselves are locked — their contents
  // are freely editable.
  if (PROTECTED_ROOTS.has(rel) && PROTECTED_ROOTS.has(top)) {
    throw new Error(`'${rel}' is a protected workspace directory`);
  }
}

export function listWorkspace(project: string, relDir: string): WorkspaceEntry[] {
  const { abs, rel } = safeWorkspacePath(project, relDir);
  if (!existsSync(abs)) {
    if (rel === "") return []; // root still being created
    throw new Error(`not found: ${rel}`);
  }
  const st = statSync(abs);
  if (!st.isDirectory()) throw new Error(`not a directory: ${rel}`);

  const names = readdirSync(abs);
  const entries: WorkspaceEntry[] = [];
  for (const name of names) {
    const full = join(abs, name);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue; // broken symlink / race — skip
    }
    const childRel = rel === "" ? name : posix.join(rel, name);
    entries.push({
      name,
      path: childRel,
      kind: s.isDirectory() ? "dir" : "file",
      size: s.isDirectory() ? 0 : s.size,
      mtime: Math.floor(s.mtimeMs),
    });
  }
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return entries;
}

export function statWorkspace(project: string, relPath: string): WorkspaceEntry {
  const { abs, rel } = safeWorkspacePath(project, relPath);
  if (!existsSync(abs)) throw new Error(`not found: ${rel}`);
  const s = statSync(abs);
  const name = rel === "" ? "" : rel.split("/").pop()!;
  return {
    name,
    path: rel,
    kind: s.isDirectory() ? "dir" : "file",
    size: s.isDirectory() ? 0 : s.size,
    mtime: Math.floor(s.mtimeMs),
  };
}

export interface ReadResult {
  path: string;
  encoding: "utf8" | "base64";
  content: string;
  size: number;
  truncated?: boolean;
  returnedBytes?: number;
  totalBytes?: number;
}

/**
 * Read a workspace file. `maxBytes` caps how much is actually returned so
 * agent tools can guard the LLM context; UI / download routes pass
 * `Infinity`.
 */
export function readWorkspaceFile(
  project: string,
  relPath: string,
  encoding: "utf8" | "base64" = "utf8",
  maxBytes: number = Infinity,
): ReadResult {
  const { abs, rel } = safeWorkspacePath(project, relPath);
  if (!existsSync(abs)) throw new Error(`not found: ${rel}`);
  const s = statSync(abs);
  if (s.isDirectory()) throw new Error(`not a file: ${rel}`);
  const totalBytes = s.size;

  let buf = readFileSync(abs);
  let truncated = false;
  if (buf.byteLength > maxBytes) {
    buf = buf.subarray(0, maxBytes);
    truncated = true;
  }
  const content = encoding === "base64" ? buf.toString("base64") : buf.toString("utf8");

  const result: ReadResult = { path: rel, encoding, content, size: totalBytes };
  if (truncated) {
    result.truncated = true;
    result.returnedBytes = buf.byteLength;
    result.totalBytes = totalBytes;
  }
  return result;
}

export interface WriteResult {
  path: string;
  size: number;
}

export function writeWorkspaceFile(
  project: string,
  relPath: string,
  data: string | Uint8Array,
  encoding: "utf8" | "base64" = "utf8",
): WriteResult {
  const { abs, rel } = safeWorkspacePath(project, relPath);
  if (rel === "") throw new Error("target path is empty");
  mkdirSync(dirname(abs), { recursive: true });
  const buf =
    typeof data === "string"
      ? encoding === "base64"
        ? Buffer.from(data, "base64")
        : Buffer.from(data, "utf8")
      : Buffer.from(data);
  writeFileSync(abs, buf);
  return { path: rel, size: buf.byteLength };
}

export function mkdirWorkspace(project: string, relPath: string): WorkspaceEntry {
  const { abs, rel } = safeWorkspacePath(project, relPath);
  if (rel === "") throw new Error("target path is empty");
  mkdirSync(abs, { recursive: true });
  return statWorkspace(project, rel);
}

export function deleteWorkspaceEntry(project: string, relPath: string): void {
  const { abs, rel } = safeWorkspacePath(project, relPath);
  assertNotProtected(rel);
  if (!existsSync(abs)) throw new Error(`not found: ${rel}`);
  rmSync(abs, { recursive: true, force: true });
}

export function moveWorkspaceEntry(
  project: string,
  from: string,
  to: string,
): WorkspaceEntry {
  const src = safeWorkspacePath(project, from);
  const dst = safeWorkspacePath(project, to);
  assertNotProtected(src.rel);
  if (dst.rel === "") throw new Error("destination path is empty");
  if (!existsSync(src.abs)) throw new Error(`not found: ${src.rel}`);
  if (existsSync(dst.abs)) throw new Error(`destination exists: ${dst.rel}`);
  mkdirSync(dirname(dst.abs), { recursive: true });
  renameSync(src.abs, dst.abs);
  return statWorkspace(project, dst.rel);
}

/**
 * Resolve a path for streaming downloads with a final realpath check so a
 * symlinked entry pointing outside the workspace can't be followed.
 */
export function resolveForDownload(project: string, relPath: string): {
  abs: string;
  rel: string;
  size: number;
} {
  const { abs, rel, root } = safeWorkspacePath(project, relPath);
  if (!existsSync(abs)) throw new Error(`not found: ${rel}`);
  const s = statSync(abs);
  if (s.isDirectory()) throw new Error(`not a file: ${rel}`);
  try {
    const real = realpathSync(abs);
    const realRoot = realpathSync(root);
    const rel2 = relative(realRoot, real);
    if (rel2.startsWith("..")) throw new Error("symlink escapes workspace");
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") throw e;
    throw e;
  }
  return { abs, rel, size: s.size };
}
