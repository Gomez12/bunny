/**
 * Git clone subsystem for code projects.
 *
 * Uses `isomorphic-git` (pure JS, bundles with the binary) instead of shelling
 * out to a system `git` — this keeps Bunny portable-by-design. The trade-off
 * is a few-× slowdown on large repos; we cap both clone depth and post-clone
 * size to bound the blast radius.
 *
 * Public-repo-only in v1: scheme validation happens up-front, no credential
 * callback is registered, so a private URL that slipped through the scheme
 * check surfaces as a 401/404 from the remote instead of hanging.
 */

import type { Database } from "bun:sqlite";
import * as fs from "node:fs";
import { rmSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import git from "isomorphic-git";
import http from "isomorphic-git/http/node";
import type { CodeConfig } from "../config.ts";
import type { BunnyQueue } from "../queue/bunqueue.ts";
import { safeWorkspacePath } from "../memory/workspace_fs.ts";
import {
  getCodeProject,
  setGitCloning,
  setGitError,
  setGitReady,
  type CodeProject,
} from "../memory/code_projects.ts";
import { errorMessage } from "../util/error.ts";

/** Schemes accepted at the route boundary. Public read-only access only. */
export const ALLOWED_GIT_SCHEMES = ["https:", "git:"] as const;

/**
 * Validate a git URL. Returns the canonical URL string on success or throws
 * with a caller-friendly message. Rejects file://, ext::, ssh://, and
 * scp-style `user@host:path` so a user can't accidentally open a credential
 * prompt or a local-path read.
 */
export function validateGitUrl(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error("git url must be a non-empty string");
  }
  const trimmed = raw.trim();
  // scp-style URLs like `git@github.com:octo/hello.git` have no scheme and
  // would otherwise slip through URL parsing as a relative path. Reject first.
  if (/^[\w.-]+@[\w.-]+:/.test(trimmed)) {
    throw new Error("scp-style git urls are not supported (use https://)");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("git url is not a valid URL");
  }
  if (!(ALLOWED_GIT_SCHEMES as readonly string[]).includes(parsed.protocol)) {
    throw new Error(
      `git url scheme '${parsed.protocol}' not supported (allowed: ${ALLOWED_GIT_SCHEMES.join(", ")})`,
    );
  }
  if (parsed.username || parsed.password) {
    throw new Error("git urls with embedded credentials are not supported");
  }
  return trimmed;
}

export interface RunCloneCtx {
  db: Database;
  queue: BunnyQueue;
  cfg: CodeConfig;
  /** Who kicked the clone. Null for background / system triggers. */
  userId: string | null;
}

/**
 * Clone / re-clone the code project referenced by `id`. Atomically claims the
 * row into `cloning`; a lost race returns false without side effects. All
 * I/O errors flip the row to `error` — the caller never needs to handle
 * exceptions from this function.
 *
 * Known gap: a process crash between `createCodeProject` (which stamps
 * `git_status='cloning'` on rows with a `gitUrl`) and this dispatch leaves
 * the row stuck. Mirror `translation.sweep_stuck` when that becomes real.
 */
export async function cloneCodeProject(
  ctx: RunCloneCtx,
  id: number,
): Promise<boolean> {
  const cp = getCodeProject(ctx.db, id);
  if (!cp) return false;
  if (!cp.gitUrl) {
    // Local-only project: ensure dir exists + mark ready so the UI can render.
    try {
      const { abs } = safeWorkspacePath(cp.project, workspaceRelForCode(cp));
      fs.mkdirSync(abs, { recursive: true });
      setGitReady(ctx.db, id);
      return true;
    } catch (e) {
      setGitError(ctx.db, id, errorMessage(e));
      return false;
    }
  }

  if (cp.gitStatus !== "cloning") {
    if (!setGitCloning(ctx.db, id)) return false;
  }

  void ctx.queue.log({
    topic: "code",
    kind: "clone.start",
    userId: ctx.userId ?? undefined,
    data: { id, project: cp.project, name: cp.name, gitUrl: cp.gitUrl },
  });

  let targetDir: string;
  try {
    const { abs } = safeWorkspacePath(cp.project, workspaceRelForCode(cp));
    targetDir = abs;
  } catch (e) {
    const msg = errorMessage(e);
    setGitError(ctx.db, id, msg);
    void ctx.queue.log({
      topic: "code",
      kind: "clone.error",
      userId: ctx.userId ?? undefined,
      data: { id, project: cp.project, error: msg },
    });
    return false;
  }

  // Reset: isomorphic-git refuses to clone into a non-empty dir, and a
  // previous failed attempt can leave one behind.
  try {
    rmSync(targetDir, { recursive: true, force: true });
    fs.mkdirSync(targetDir, { recursive: true });
  } catch {
    /* non-fatal; git.clone will surface a clear error if the path is unusable */
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("clone timeout")),
    ctx.cfg.cloneTimeoutMs,
  );

  try {
    await git.clone({
      fs,
      http,
      dir: targetDir,
      url: cp.gitUrl,
      ref: cp.gitRef ?? undefined,
      singleBranch: true,
      depth: ctx.cfg.defaultCloneDepth,
      noTags: true,
    });
    clearTimeout(timeout);

    const sizeMb = directorySizeMb(targetDir);
    if (sizeMb > ctx.cfg.maxRepoSizeMb) {
      // Over-budget clone — wipe and surface the limit instead of leaving a
      // half-useful checkout on disk.
      try {
        rmSync(targetDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      const msg = `repository exceeds max size (${sizeMb.toFixed(1)}MB > ${ctx.cfg.maxRepoSizeMb}MB)`;
      setGitError(ctx.db, id, msg);
      void ctx.queue.log({
        topic: "code",
        kind: "clone.error",
        userId: ctx.userId ?? undefined,
        data: { id, project: cp.project, error: msg, sizeMb },
      });
      return false;
    }

    setGitReady(ctx.db, id);
    void ctx.queue.log({
      topic: "code",
      kind: "clone.success",
      userId: ctx.userId ?? undefined,
      data: { id, project: cp.project, name: cp.name, sizeMb },
    });
    return true;
  } catch (e) {
    clearTimeout(timeout);
    const msg = errorMessage(e);
    setGitError(ctx.db, id, msg);
    void ctx.queue.log({
      topic: "code",
      kind: "clone.error",
      userId: ctx.userId ?? undefined,
      data: { id, project: cp.project, error: msg },
    });
    return false;
  }
}

/** Workspace-relative path to a code project's root directory. */
export function workspaceRelForCode(cp: Pick<CodeProject, "name">): string {
  return `code/${cp.name}`;
}

/** Walk a directory and return its total size in megabytes. */
function directorySizeMb(root: string): number {
  let total = 0;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(full);
      else if (st.isFile()) total += st.size;
    }
  }
  return total / (1024 * 1024);
}
