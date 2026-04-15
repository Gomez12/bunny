/**
 * HTTP routes for per-project file workspaces.
 *
 * Mounted from `routes.ts:handleApi` between the board routes and the
 * generic project routes.
 *
 *   GET    /api/projects/:project/workspace/list?path=...
 *   GET    /api/projects/:project/workspace/file?path=...&encoding=utf8|base64|raw
 *   POST   /api/projects/:project/workspace/file            (multipart OR JSON)
 *   POST   /api/projects/:project/workspace/mkdir           { path }
 *   POST   /api/projects/:project/workspace/move            { from, to }
 *   DELETE /api/projects/:project/workspace?path=...
 */

import type { Database } from "bun:sqlite";
import type { User } from "../auth/users.ts";
import { errorMessage } from "../util/error.ts";
import { json } from "./http.ts";
import { canEditProject, canSeeProject } from "./routes.ts";
import { getProject, validateProjectName } from "../memory/projects.ts";
import {
  deleteWorkspaceEntry,
  listWorkspace,
  mkdirWorkspace,
  moveWorkspaceEntry,
  readWorkspaceFile,
  resolveForDownload,
  statWorkspace,
  writeWorkspaceFile,
} from "../memory/workspace_fs.ts";

/** Hard per-file upload cap. */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export interface WorkspaceRouteCtx {
  db: Database;
}

export async function handleWorkspaceRoute(
  req: Request,
  url: URL,
  ctx: WorkspaceRouteCtx,
  user: User,
): Promise<Response | null> {
  const match = url.pathname.match(/^\/api\/projects\/([^/]+)\/workspace(?:\/(list|file|mkdir|move))?$/);
  if (!match) return null;

  let project: string;
  try {
    project = validateProjectName(decodeURIComponent(match[1]!));
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
  const p = getProject(ctx.db, project);
  if (!p) return json({ error: "project not found" }, 404);

  const action = match[2]; // "list" | "file" | "mkdir" | "move" | undefined

  // Read paths require canSeeProject; any mutation requires canEditProject.
  const readOnly =
    req.method === "GET" && (action === "list" || action === "file");
  if (readOnly) {
    if (!canSeeProject(p, user)) return json({ error: "forbidden" }, 403);
  } else {
    if (!canEditProject(p, user)) return json({ error: "forbidden" }, 403);
  }

  try {
    if (action === "list" && req.method === "GET") {
      const path = url.searchParams.get("path") ?? "";
      const entries = listWorkspace(project, path);
      return json({ project, path, entries });
    }
    if (action === "file" && req.method === "GET") {
      return handleGetFile(project, url);
    }
    if (action === "file" && req.method === "POST") {
      return handleUpload(req, project);
    }
    if (action === "mkdir" && req.method === "POST") {
      const body = (await readJson<{ path?: string }>(req)) ?? {};
      if (!body.path) return json({ error: "missing path" }, 400);
      const entry = mkdirWorkspace(project, body.path);
      return json({ entry }, 201);
    }
    if (action === "move" && req.method === "POST") {
      const body = (await readJson<{ from?: string; to?: string }>(req)) ?? {};
      if (!body.from || !body.to) return json({ error: "missing from/to" }, 400);
      const entry = moveWorkspaceEntry(project, body.from, body.to);
      return json({ entry });
    }
    if (!action && req.method === "DELETE") {
      const path = url.searchParams.get("path");
      if (!path) return json({ error: "missing path" }, 400);
      deleteWorkspaceEntry(project, path);
      return json({ ok: true });
    }
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }

  return null;
}

function handleGetFile(project: string, url: URL): Response {
  const path = url.searchParams.get("path");
  if (!path) return json({ error: "missing path" }, 400);
  const encoding = url.searchParams.get("encoding") ?? "utf8";

  try {
    if (encoding === "raw") {
      const { abs, rel, size } = resolveForDownload(project, path);
      const file = Bun.file(abs);
      const filename = rel.split("/").pop() ?? "download";
      return new Response(file, {
        headers: {
          "Content-Type": file.type || "application/octet-stream",
          "Content-Length": String(size),
          "Content-Disposition": `attachment; filename="${encodeURIComponent(filename)}"`,
          "Cache-Control": "no-store",
        },
      });
    }
    const enc = encoding === "base64" ? "base64" : "utf8";
    const result = readWorkspaceFile(project, path, enc, Infinity);
    return json(result);
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

async function handleUpload(req: Request, project: string): Promise<Response> {
  const contentType = req.headers.get("content-type") ?? "";

  // JSON body: { path, content, encoding? }
  if (contentType.includes("application/json")) {
    const body = (await readJson<{ path?: string; content?: string; encoding?: string }>(req)) ?? {};
    if (!body.path || body.content === undefined) {
      return json({ error: "missing path / content" }, 400);
    }
    const enc = body.encoding === "base64" ? "base64" : "utf8";
    try {
      const result = writeWorkspaceFile(project, body.path, body.content, enc);
      return json({ entry: statWorkspace(project, result.path) }, 201);
    } catch (e) {
      return json({ error: errorMessage(e) }, 400);
    }
  }

  // Multipart upload: one or more files, optional `path` field (target dir).
  if (contentType.includes("multipart/form-data")) {
    let form: Awaited<ReturnType<Request["formData"]>>;
    try {
      form = await req.formData();
    } catch (e) {
      return json({ error: errorMessage(e) }, 400);
    }
    const rawDir = form.get("path");
    const targetDir = typeof rawDir === "string" ? rawDir : "";
    interface BlobLike {
      name: string;
      size: number;
      arrayBuffer(): Promise<ArrayBuffer>;
    }
    const isFileLike = (v: unknown): v is BlobLike =>
      typeof v === "object" &&
      v !== null &&
      typeof (v as { arrayBuffer?: unknown }).arrayBuffer === "function" &&
      typeof (v as { name?: unknown }).name === "string";
    const files = (form.getAll("file") as unknown[]).filter(isFileLike);
    if (files.length === 0) return json({ error: "no files in upload" }, 400);

    const stored: unknown[] = [];
    try {
      for (const f of files) {
        if (f.size > MAX_UPLOAD_BYTES) {
          return json({ error: `file too large: ${f.name}` }, 413);
        }
        const rel = targetDir ? `${targetDir.replace(/\/+$/, "")}/${f.name}` : f.name;
        const buf = new Uint8Array(await f.arrayBuffer());
        const written = writeWorkspaceFile(project, rel, buf, "utf8");
        stored.push(statWorkspace(project, written.path));
      }
    } catch (e) {
      return json({ error: errorMessage(e) }, 400);
    }
    return json({ entries: stored }, 201);
  }

  return json({ error: "unsupported content-type" }, 415);
}

async function readJson<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}
