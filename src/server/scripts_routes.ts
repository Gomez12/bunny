/**
 * HTTP routes for the Scripts subsystem.
 *
 *   GET    /api/code/:codeProjectId/scripts                  list scripts
 *   POST   /api/code/:codeProjectId/scripts                  create script
 *   GET    /api/scripts/runtimes                             runtime config (admin)
 *   PATCH  /api/scripts/runtimes                             update runtime config (admin)
 *   GET    /api/scripts/:id                                  get + on-open disk check
 *   PATCH  /api/scripts/:id                                  update
 *   DELETE /api/scripts/:id                                  soft-delete
 *   POST   /api/scripts/:id/promote                          temp → regular
 *   GET    /api/scripts/:id/versions                         list versions
 *   GET    /api/scripts/:id/versions/:versionId              get version
 *   POST   /api/scripts/:id/versions/:versionId/restore      restore version
 *   POST   /api/scripts/:id/run                              execute (SSE)
 *   POST   /api/scripts/:id/chat                             LLM chat (SSE)
 *   POST   /api/scripts/:id/sync                             manual disk sync
 *
 * See docs/dev/entities/scripts.md, ADR 0037.
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { sha256Hex } from "../util/hash.ts";
import { atomicWrite } from "../util/atomic_fs.ts";
import type { Database } from "bun:sqlite";
import type { BunnyConfig } from "../config.ts";
import type { BunnyQueue } from "../queue/bunqueue.ts";
import type { User } from "../auth/users.ts";
import { errorMessage } from "../util/error.ts";
import { json, readJson } from "./http.ts";
import { canSeeProject, canEditProject } from "./route_helpers.ts";
import { getProject } from "../memory/projects.ts";
import { getCodeProject } from "../memory/code_projects.ts";
import { workspaceDir } from "../memory/project_assets.ts";
import {
  listScripts,
  getScript,
  createScript,
  updateScript,
  deleteScript,
  promoteScript,
  pruneScriptVersions,
  listScriptVersions,
  getScriptVersion,
  canEditScript,
  scriptRelPath,
  scriptRunTmpRelPath,
  LANGUAGE_TO_EXT,
  type ScriptLanguage,
} from "../memory/scripts.ts";
import { restore } from "../memory/trash.ts";
import { runAgent } from "../agent/loop.ts";
import {
  createSseRenderer,
  controllerSink,
  finishSse,
} from "../agent/render_sse.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { renderPrompt } from "../prompts/resolve.ts";
import { paths } from "../paths.ts";

export interface ScriptRouteCtx {
  db: Database;
  queue: BunnyQueue;
  cfg: BunnyConfig;
}

const sseEncoder = new TextEncoder();

function sendSse(
  controller: ReadableStreamDefaultController<Uint8Array>,
  payload: object,
): void {
  try {
    controller.enqueue(
      sseEncoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
    );
  } catch {
    /* client disconnected */
  }
}

/** Get the runtime executable + args for a given script language. Returns null
 * if the language requires configuration that isn't set. Exported for tests. */
export function resolveRuntime(
  language: ScriptLanguage,
  cfg: BunnyConfig,
): { exe: string; extraArgs: string[] } | null {
  switch (language) {
    case "javascript":
    case "typescript": {
      // process.execPath in a compiled Bunny binary points to the Bunny executable,
      // not the Bun runtime. Use Bun.which to find the real bun on PATH.
      const bunExe = cfg.scripts.bunPath || Bun.which("bun") || "bun";
      return { exe: bunExe, extraArgs: ["run"] };
    }
    case "csharp":
      return cfg.scripts.dotnetPath
        ? { exe: cfg.scripts.dotnetPath, extraArgs: ["run"] }
        : null;
    case "python":
      return cfg.scripts.pythonPath
        ? { exe: cfg.scripts.pythonPath, extraArgs: [] }
        : null;
    case "bash":
      return { exe: "bash", extraArgs: [] };
    case "powershell":
      return { exe: cfg.scripts.powershellPath || "pwsh", extraArgs: ["-File"] };
    case "go":
      return { exe: cfg.scripts.goPath || "go", extraArgs: ["run"] };
    case "sql":
      return null; // SQL requires a DB connection
  }
}

// ── Public entry point ───────────────────────────────────────────────────────

export async function handleScriptRoute(
  req: Request,
  url: URL,
  ctx: ScriptRouteCtx,
  user: User,
): Promise<Response | null> {
  const { pathname } = url;

  // ── /api/code/:codeProjectId/scripts ─────────────────────────────────────
  const codeListMatch = pathname.match(/^\/api\/code\/(\d+)\/scripts$/);
  if (codeListMatch) {
    const cpId = Number(codeListMatch[1]);
    if (req.method === "GET") return handleList(ctx, user, cpId, url);
    if (req.method === "POST") return handleCreate(req, ctx, user, cpId);
    return json({ error: "method not allowed" }, 405);
  }

  // ── /api/scripts/runtimes  (must precede :id pattern) ────────────────────
  if (pathname === "/api/scripts/runtimes") {
    if (req.method === "GET") return handleGetRuntimes(ctx, user);
    if (req.method === "PATCH") return handlePatchRuntimes(req, ctx, user);
    return json({ error: "method not allowed" }, 405);
  }

  // ── /api/scripts/:id ─────────────────────────────────────────────────────
  const idMatch = pathname.match(/^\/api\/scripts\/(\d+)$/);
  if (idMatch) {
    const id = Number(idMatch[1]);
    if (req.method === "GET") return handleGet(ctx, user, id);
    if (req.method === "PATCH") return handlePatch(req, ctx, user, id);
    if (req.method === "DELETE") return handleDelete(ctx, user, id);
    return json({ error: "method not allowed" }, 405);
  }

  // ── /api/scripts/:id/promote ──────────────────────────────────────────────
  const promoteMatch = pathname.match(/^\/api\/scripts\/(\d+)\/promote$/);
  if (promoteMatch) {
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    return handlePromote(ctx, user, Number(promoteMatch[1]));
  }

  // ── /api/scripts/:id/versions ─────────────────────────────────────────────
  const versionsMatch = pathname.match(/^\/api\/scripts\/(\d+)\/versions$/);
  if (versionsMatch) {
    if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
    return handleListVersions(ctx, user, Number(versionsMatch[1]));
  }

  // ── /api/scripts/:id/versions/:versionId ─────────────────────────────────
  const versionItemMatch = pathname.match(
    /^\/api\/scripts\/(\d+)\/versions\/(\d+)$/,
  );
  if (versionItemMatch) {
    if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
    return handleGetVersion(
      ctx,
      user,
      Number(versionItemMatch[1]),
      Number(versionItemMatch[2]),
    );
  }

  // ── /api/scripts/:id/versions/:versionId/restore ─────────────────────────
  const restoreVersionMatch = pathname.match(
    /^\/api\/scripts\/(\d+)\/versions\/(\d+)\/restore$/,
  );
  if (restoreVersionMatch) {
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    return handleRestoreVersion(
      ctx,
      user,
      Number(restoreVersionMatch[1]),
      Number(restoreVersionMatch[2]),
    );
  }

  // ── /api/scripts/:id/run ─────────────────────────────────────────────────
  const runMatch = pathname.match(/^\/api\/scripts\/(\d+)\/run$/);
  if (runMatch) {
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    return handleRun(ctx, user, Number(runMatch[1]));
  }

  // ── /api/scripts/:id/chat ─────────────────────────────────────────────────
  const chatMatch = pathname.match(/^\/api\/scripts\/(\d+)\/chat$/);
  if (chatMatch) {
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    return handleChat(req, ctx, user, Number(chatMatch[1]));
  }

  // ── /api/scripts/:id/sync ─────────────────────────────────────────────────
  const syncMatch = pathname.match(/^\/api\/scripts\/(\d+)\/sync$/);
  if (syncMatch) {
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    return handleSync(ctx, user, Number(syncMatch[1]));
  }

  return null;
}

// ── List ──────────────────────────────────────────────────────────────────────

function handleList(
  ctx: ScriptRouteCtx,
  user: User,
  codeProjectId: number,
  url: URL,
): Response {
  const cp = getCodeProject(ctx.db, codeProjectId);
  if (!cp) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, cp.project);
  if (!p) return json({ error: "project not found" }, 404);
  if (!canSeeProject(p, user)) return json({ error: "forbidden" }, 403);

  const includeTemp = url.searchParams.get("includeTemp") === "true";
  const scripts = listScripts(ctx.db, codeProjectId, { includeTemp });
  return json({ scripts });
}

// ── Create ────────────────────────────────────────────────────────────────────

async function handleCreate(
  req: Request,
  ctx: ScriptRouteCtx,
  user: User,
  codeProjectId: number,
): Promise<Response> {
  const cp = getCodeProject(ctx.db, codeProjectId);
  if (!cp) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, cp.project);
  if (!p) return json({ error: "project not found" }, 404);
  if (!canEditProject(p, user)) return json({ error: "forbidden" }, 403);

  const body = await readJson<{
    name?: string;
    description?: string;
    content?: string;
    language?: string;
    isTemp?: boolean;
  }>(req);

  const isTemp = body?.isTemp ?? false;
  if (!isTemp && !body?.name?.trim()) {
    return json({ error: "name required for non-temp scripts" }, 400);
  }

  const language = body?.language as ScriptLanguage | undefined;

  try {
    const script = createScript(ctx.db, {
      codeProjectId,
      project: cp.project,
      name: body?.name?.trim() || undefined,
      description: body?.description ?? "",
      content: body?.content ?? "",
      language,
      isTemp,
      createdBy: user.id,
    });

    // Write to disk
    writeDisk(cp.project, cp.name, script.name, script.language, script.isTemp, script.content, ctx.db, script.id);

    void ctx.queue.log({
      topic: "scripts",
      kind: "create",
      userId: user.id,
      data: { id: script.id, codeProjectId, project: cp.project, isTemp },
    });

    return json({ script }, 201);
  } catch (e) {
    const msg = errorMessage(e);
    if (msg.includes("UNIQUE constraint")) {
      return json({ error: "name_conflict" }, 409);
    }
    return json({ error: msg }, 400);
  }
}

// ── Get (with on-open disk check) ────────────────────────────────────────────

async function handleGet(
  ctx: ScriptRouteCtx,
  user: User,
  id: number,
): Promise<Response> {
  const script = getScript(ctx.db, id);
  if (!script) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, script.project);
  if (!p) return json({ error: "project not found" }, 404);
  if (!canSeeProject(p, user)) return json({ error: "forbidden" }, 403);

  const cp = getCodeProject(ctx.db, script.codeProjectId);
  if (!cp) return json({ error: "code project not found" }, 404);

  // On-open disk check
  const wsRoot = workspaceDir(script.project);
  const diskState = checkDisk(wsRoot, cp.name, script);

  if (diskState === "restored") {
    // File was missing; we wrote it from DB. Return the script as-is.
    return json({ script });
  }

  if (diskState && diskState.diskDiffers) {
    return json({
      script: { ...script, diskContent: diskState.diskContent, diskDiffers: true },
    });
  }

  return json({ script });
}

// ── Patch ─────────────────────────────────────────────────────────────────────

async function handlePatch(
  req: Request,
  ctx: ScriptRouteCtx,
  user: User,
  id: number,
): Promise<Response> {
  const script = getScript(ctx.db, id);
  if (!script) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, script.project);
  if (!p) return json({ error: "project not found" }, 404);
  if (!canEditScript(user, script, p)) return json({ error: "forbidden" }, 403);

  const cp = getCodeProject(ctx.db, script.codeProjectId);
  if (!cp) return json({ error: "code project not found" }, 404);

  const body = await readJson<{
    name?: string;
    description?: string;
    content?: string;
    language?: ScriptLanguage;
    isTemp?: boolean;
    createVersion?: boolean;
  }>(req);

  if (!body) return json({ error: "invalid body" }, 400);

  const { createVersion, ...patch } = body;

  try {
    const updated = updateScript(ctx.db, id, patch, {
      createdBy: user.id,
      createVersion: createVersion ?? false,
    });
    if (!updated) return json({ error: "not found" }, 404);

    // Prune versions if a new one was created
    if (createVersion && patch.content !== undefined) {
      pruneScriptVersions(
        ctx.db,
        id,
        ctx.cfg.scripts.maxVersionsPerScript,
      );
    }

    // Write to disk (handle potential name/language change)
      const wsRoot = workspaceDir(script.project);

    // If name or language changed, remove the old disk file
    if (
      (patch.name && patch.name !== script.name) ||
      (patch.language && patch.language !== script.language) ||
      (patch.isTemp !== undefined && patch.isTemp !== script.isTemp)
    ) {
      const oldRel = scriptRelPath(cp.name, script.name, script.language, script.isTemp);
      const oldAbs = join(wsRoot, oldRel);
      if (existsSync(oldAbs)) unlinkSync(oldAbs);
    }

    writeDisk(
      script.project,
      cp.name,
      updated.name,
      updated.language,
      updated.isTemp,
      updated.content,
      ctx.db,
      id,
    );

    void ctx.queue.log({
      topic: "scripts",
      kind: "update",
      userId: user.id,
      data: { id, project: script.project },
    });

    return json({ script: updated });
  } catch (e) {
    const msg = errorMessage(e);
    if (msg.includes("UNIQUE constraint")) return json({ error: "name_conflict" }, 409);
    return json({ error: msg }, 400);
  }
}

// ── Delete ────────────────────────────────────────────────────────────────────

async function handleDelete(
  ctx: ScriptRouteCtx,
  user: User,
  id: number,
): Promise<Response> {
  const script = getScript(ctx.db, id);
  if (!script) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, script.project);
  if (!p) return json({ error: "project not found" }, 404);
  if (!canEditScript(user, script, p)) return json({ error: "forbidden" }, 403);

  const cp = getCodeProject(ctx.db, script.codeProjectId);
  if (cp) {
    // Rename disk file to __trash: prefix before DB soft-delete
    const wsRoot = workspaceDir(script.project);
      const relPath = scriptRelPath(
      cp.name,
      script.name,
      script.language,
      script.isTemp,
    );
    const absPath = join(wsRoot, relPath);
    if (existsSync(absPath)) {
      const trashRel = scriptRelPath(
        cp.name,
        `__trash:${id}:${script.name}`,
        script.language,
        script.isTemp,
      );
      const trashAbs = join(wsRoot, trashRel);
      try {
        renameSync(absPath, trashAbs);
      } catch {
        /* best-effort */
      }
    }
  }

  if (!deleteScript(ctx.db, id, user.id)) {
    return json({ error: "not found" }, 404);
  }

  void ctx.queue.log({
    topic: "scripts",
    kind: "delete",
    userId: user.id,
    data: { id, project: script.project },
  });

  return json({ ok: true });
}

// ── Promote ───────────────────────────────────────────────────────────────────

async function handlePromote(
  ctx: ScriptRouteCtx,
  user: User,
  id: number,
): Promise<Response> {
  const script = getScript(ctx.db, id);
  if (!script) return json({ error: "not found" }, 404);
  if (!script.isTemp) return json({ error: "not a temp script" }, 400);
  const p = getProject(ctx.db, script.project);
  if (!p) return json({ error: "project not found" }, 404);
  if (!canEditScript(user, script, p)) return json({ error: "forbidden" }, 403);

  const cp = getCodeProject(ctx.db, script.codeProjectId);
  if (!cp) return json({ error: "code project not found" }, 404);

  const wsRoot = workspaceDir(script.project);

  const tempRel = scriptRelPath(cp.name, script.name, script.language, true);
  const permRel = scriptRelPath(cp.name, script.name, script.language, false);
  const tempAbs = join(wsRoot, tempRel);
  const permAbs = join(wsRoot, permRel);

  // Check disk conflict
  if (existsSync(permAbs)) {
    return json({ error: "name_conflict" }, 409);
  }

  // DB promotion
  if (!promoteScript(ctx.db, id)) {
    return json({ error: "not found" }, 404);
  }

  // Move disk file
  if (existsSync(tempAbs)) {
    mkdirSync(dirname(permAbs), { recursive: true });
    renameSync(tempAbs, permAbs);
  } else {
    // Write from DB content if temp file is missing
    atomicWrite(permAbs, script.content);
  }

  void ctx.queue.log({
    topic: "scripts",
    kind: "promote",
    userId: user.id,
    data: { id, project: script.project },
  });

  return json({ script: getScript(ctx.db, id) });
}

// ── Versions ──────────────────────────────────────────────────────────────────

function handleListVersions(
  ctx: ScriptRouteCtx,
  user: User,
  scriptId: number,
): Response {
  const script = getScript(ctx.db, scriptId);
  if (!script) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, script.project);
  if (!p) return json({ error: "project not found" }, 404);
  if (!canSeeProject(p, user)) return json({ error: "forbidden" }, 403);

  const versions = listScriptVersions(ctx.db, scriptId);
  return json({ versions });
}

function handleGetVersion(
  ctx: ScriptRouteCtx,
  user: User,
  scriptId: number,
  versionId: number,
): Response {
  const script = getScript(ctx.db, scriptId);
  if (!script) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, script.project);
  if (!p) return json({ error: "project not found" }, 404);
  if (!canSeeProject(p, user)) return json({ error: "forbidden" }, 403);

  const version = getScriptVersion(ctx.db, versionId);
  if (!version || version.scriptId !== scriptId) {
    return json({ error: "not found" }, 404);
  }
  return json({ version });
}

async function handleRestoreVersion(
  ctx: ScriptRouteCtx,
  user: User,
  scriptId: number,
  versionId: number,
): Promise<Response> {
  const script = getScript(ctx.db, scriptId);
  if (!script) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, script.project);
  if (!p) return json({ error: "project not found" }, 404);
  if (!canEditScript(user, script, p)) return json({ error: "forbidden" }, 403);

  const version = getScriptVersion(ctx.db, versionId);
  if (!version || version.scriptId !== scriptId) {
    return json({ error: "version not found" }, 404);
  }

  const cp = getCodeProject(ctx.db, script.codeProjectId);
  if (!cp) return json({ error: "code project not found" }, 404);

  // Restore creates a new version snapshot of current content
  const updated = updateScript(
    ctx.db,
    scriptId,
    { content: version.content },
    { createdBy: user.id, createVersion: true },
  );
  if (!updated) return json({ error: "not found" }, 404);

  pruneScriptVersions(ctx.db, scriptId, ctx.cfg.scripts.maxVersionsPerScript);

  writeDisk(
    script.project,
    cp.name,
    script.name,
    script.language,
    script.isTemp,
    version.content,
    ctx.db,
    scriptId,
  );

  void ctx.queue.log({
    topic: "scripts",
    kind: "version.restore",
    userId: user.id,
    data: { id: scriptId, versionId, project: script.project },
  });

  return json({ script: updated });
}

// ── Run (SSE) ─────────────────────────────────────────────────────────────────

async function handleRun(
  ctx: ScriptRouteCtx,
  user: User,
  id: number,
): Promise<Response> {
  const script = getScript(ctx.db, id);
  if (!script) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, script.project);
  if (!p) return json({ error: "project not found" }, 404);
  if (!canEditScript(user, script, p)) return json({ error: "forbidden" }, 403);

  if (script.language === "sql") {
    return json({ error: "sql_requires_connection" }, 422);
  }

  const runtime = resolveRuntime(script.language, ctx.cfg);
  if (!runtime) {
    return json(
      {
        error: "runtime_not_configured",
        language: script.language,
        hint: "Configure the runtime path in Settings → Script Runtimes",
      },
      422,
    );
  }

  const cp = getCodeProject(ctx.db, script.codeProjectId);
  if (!cp) return json({ error: "code project not found" }, 404);

  const wsRoot = workspaceDir(script.project);
  const tmpRel = scriptRunTmpRelPath(cp.name, id, script.language);
  const tmpAbs = join(wsRoot, tmpRel);
  const codeProjectDir = join(wsRoot, `code/${cp.name}`);

  // Write execution temp file (force-save current DB content before run)
  atomicWrite(tmpAbs, script.content);

  const runId = crypto.randomUUID();

  void ctx.queue.log({
    topic: "scripts",
    kind: "run",
    userId: user.id,
    data: { id, project: script.project, language: script.language, runId },
  });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      sendSse(controller, { type: "script_run_started", scriptId: id, runId });

      const started = Date.now();
      let timedOut = false;
      let proc: ReturnType<typeof Bun.spawn> | null = null;

      const killTimer = setTimeout(() => {
        timedOut = true;
        proc?.kill();
      }, ctx.cfg.scripts.execTimeoutMs);

      try {
        proc = Bun.spawn(
          [runtime.exe, ...runtime.extraArgs, tmpAbs],
          {
            cwd: codeProjectDir,
            stdout: "pipe",
            stderr: "pipe",
          },
        );

        let outputBytes = 0;
        const limit = ctx.cfg.scripts.maxOutputBytes;

        const drainStream = async (
          readable: ReadableStream<Uint8Array>,
          stream: "stdout" | "stderr",
        ) => {
          for await (const chunk of readable as AsyncIterable<Uint8Array>) {
            if (outputBytes >= limit) continue;
            const text = new TextDecoder().decode(chunk);
            outputBytes += chunk.byteLength;
            sendSse(controller, {
              type: "script_run_output",
              runId,
              stream,
              text,
            });
          }
        };

        await Promise.all([
          drainStream(proc.stdout as ReadableStream<Uint8Array>, "stdout"),
          drainStream(proc.stderr as ReadableStream<Uint8Array>, "stderr"),
        ]);

        const exitCode = await proc.exited;
        clearTimeout(killTimer);
        const durationMs = Date.now() - started;

        sendSse(controller, {
          type: "script_run_finished",
          runId,
          exitCode: timedOut ? null : exitCode,
          durationMs,
          timedOut: timedOut || undefined,
        });
      } catch (e) {
        clearTimeout(killTimer);
        sendSse(controller, {
          type: "script_run_finished",
          runId,
          exitCode: null,
          durationMs: Date.now() - started,
          error: errorMessage(e),
        });
      } finally {
        // Clean up temp file
        try {
          unlinkSync(tmpAbs);
        } catch {
          /* best-effort */
        }
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Script-Id": String(id),
      "X-Run-Id": runId,
    },
  });
}

// ── Chat (SSE) ────────────────────────────────────────────────────────────────

async function handleChat(
  req: Request,
  ctx: ScriptRouteCtx,
  user: User,
  id: number,
): Promise<Response> {
  const script = getScript(ctx.db, id);
  if (!script) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, script.project);
  if (!p) return json({ error: "project not found" }, 404);
  if (!canSeeProject(p, user)) return json({ error: "forbidden" }, 403);

  const cp = getCodeProject(ctx.db, script.codeProjectId);
  if (!cp) return json({ error: "code project not found" }, 404);

  const body = await readJson<{
    sessionId?: string;
    prompt?: string;
    /** Current editor content — sent directly so the LLM always sees the
     *  latest unsaved state without a disk round-trip. Falls back to DB content. */
    content?: string;
  }>(req);
  const prompt = body?.prompt?.trim();
  if (!prompt) return json({ error: "missing prompt" }, 400);

  const sessionId =
    body?.sessionId?.trim() || `script-chat-${id}-${crypto.randomUUID()}`;

  const systemPrompt = renderPrompt(
    "scripts.chat",
    {
      scriptName: script.name,
      scriptLanguage: script.language,
      scriptContent: body?.content ?? script.content,
      codeProjectName: cp.name,
    },
    { project: script.project },
  );

  void ctx.queue.log({
    topic: "scripts",
    kind: "chat",
    userId: user.id,
    data: { id, project: script.project, sessionId },
  });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const sink = controllerSink(controller);
      const renderer = createSseRenderer(sink);
      try {
        await runAgent({
          prompt,
          sessionId,
          userId: user.id,
          project: script.project,
          llmCfg: ctx.cfg.llm,
          embedCfg: ctx.cfg.embed,
          memoryCfg: ctx.cfg.memory,
          agentCfg: ctx.cfg.agent,
          webCfg: ctx.cfg.web,
          tools: new ToolRegistry(),
          db: ctx.db,
          queue: ctx.queue,
          renderer,
          systemPromptOverride: systemPrompt,
        });
      } catch (e) {
        renderer.onError(errorMessage(e));
      } finally {
        finishSse(sink);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Session-Id": sessionId,
      "X-Script-Id": String(id),
    },
  });
}

// ── Sync ──────────────────────────────────────────────────────────────────────

async function handleSync(
  ctx: ScriptRouteCtx,
  user: User,
  id: number,
): Promise<Response> {
  const script = getScript(ctx.db, id);
  if (!script) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, script.project);
  if (!p) return json({ error: "project not found" }, 404);
  if (!canSeeProject(p, user)) return json({ error: "forbidden" }, 403);

  const cp = getCodeProject(ctx.db, script.codeProjectId);
  if (!cp) return json({ error: "code project not found" }, 404);

  const wsRoot = workspaceDir(script.project);
  const diskState = checkDisk(wsRoot, cp.name, script);

  if (diskState === "restored") {
    return json({ synced: "restored" });
  }
  if (diskState?.diskDiffers) {
    // Auto-import external edit
    const updated = updateScript(
      ctx.db,
      id,
      { content: diskState.diskContent, fileHash: sha256Hex(diskState.diskContent) },
      { createdBy: undefined, createVersion: true },
    );
    pruneScriptVersions(ctx.db, id, ctx.cfg.scripts.maxVersionsPerScript);
    return json({ synced: "imported", script: updated });
  }
  return json({ synced: "up_to_date" });
}

// ── Runtime config ────────────────────────────────────────────────────────────

function handleGetRuntimes(ctx: ScriptRouteCtx, user: User): Response {
  if (user.role !== "admin") return json({ error: "forbidden" }, 403);
  const { bunPath, dotnetPath, pythonPath, powershellPath, goPath } =
    ctx.cfg.scripts;
  return json({ bunPath, dotnetPath, pythonPath, powershellPath, goPath });
}

async function handlePatchRuntimes(
  req: Request,
  ctx: ScriptRouteCtx,
  user: User,
): Promise<Response> {
  if (user.role !== "admin") return json({ error: "forbidden" }, 403);

  const body = await readJson<Partial<{
    bunPath: string;
    dotnetPath: string;
    pythonPath: string;
    powershellPath: string;
    goPath: string;
  }>>(req);
  if (!body) return json({ error: "invalid body" }, 400);

  writeScriptsConfig(body);

  void ctx.queue.log({
    topic: "scripts",
    kind: "config.update",
    userId: user.id,
    data: body,
  });

  return json({ ok: true });
}

// ── Shared helpers ────────────────────────────────────────────────────────────

/** Write script content to disk atomically + update file_hash in DB. */
function writeDisk(
  bunnyProject: string,
  codeProjectName: string,
  scriptName: string,
  language: ScriptLanguage,
  isTemp: boolean,
  content: string,
  db: Database,
  scriptId: number,
): void {
  const wsRoot = workspaceDir(bunnyProject);
  const relPath = scriptRelPath(codeProjectName, scriptName, language, isTemp);
  const absPath = join(wsRoot, relPath);
  atomicWrite(absPath, content);
  const hash = sha256Hex(content);
  db.prepare(
    `UPDATE scripts SET file_hash = ?, updated_at = ? WHERE id = ?`,
  ).run(hash, Date.now(), scriptId);
}

/**
 * Check disk state for a script.
 * Returns:
 *  - `"restored"` if the disk file was missing and was written from DB
 *  - `{ diskContent, diskDiffers }` if the file exists and was compared
 *  - `null` if the code project can't be resolved
 */
function checkDisk(
  wsRoot: string,
  codeProjectName: string,
  script: Awaited<ReturnType<typeof getScript>>,
): "restored" | { diskContent: string; diskDiffers: boolean } | null {
  if (!script) return null;
  const relPath = scriptRelPath(
    codeProjectName,
    script.name,
    script.language,
    script.isTemp,
  );
  const absPath = join(wsRoot, relPath);

  if (!existsSync(absPath)) {
    // Restore missing disk file
    atomicWrite(absPath, script.content);
    return "restored";
  }

  const diskContent = readFileSync(absPath, "utf8");
  const diskHash = sha256Hex(diskContent);
  return { diskContent, diskDiffers: diskHash !== (script.fileHash ?? "") };
}

/** Write `[scripts]` runtime paths back to bunny.config.toml. */
function writeScriptsConfig(
  patch: Partial<{
    bunPath: string;
    dotnetPath: string;
    pythonPath: string;
    powershellPath: string;
    goPath: string;
  }>,
): void {
  const file = paths.configFile(process.cwd());
  let existing = "";
  try {
    existing = readFileSync(file, "utf8");
  } catch {
    existing = "";
  }
  const parsed = existing
    ? ((Bun.TOML.parse(existing) as Record<string, unknown>) ?? {})
    : {};
  const current = (parsed["scripts"] as Record<string, unknown> | undefined) ?? {};
  const keyMap: Record<string, string> = {
    bunPath: "bun_path",
    dotnetPath: "dotnet_path",
    pythonPath: "python_path",
    powershellPath: "powershell_path",
    goPath: "go_path",
  };
  for (const [camel, snake] of Object.entries(keyMap)) {
    const v = (patch as Record<string, unknown>)[camel];
    if (typeof v === "string") current[snake] = v;
  }
  const nextToml = replaceOrAppendSection(existing, "scripts", current);
  writeFileSync(file, nextToml, "utf8");
}

function replaceOrAppendSection(
  toml: string,
  section: string,
  values: Record<string, unknown>,
): string {
  const stripped = stripSection(toml, section);
  const keys = Object.keys(values).filter((k) => typeof values[k] === "string");
  if (keys.length === 0) return stripped;
  const header = stripped.length && !stripped.endsWith("\n") ? "\n" : "";
  const lines = [`[${section}]`];
  for (const k of keys) {
    lines.push(`${k} = ${JSON.stringify(values[k])}`);
  }
  return `${stripped}${header}${lines.join("\n")}\n`;
}

function stripSection(text: string, section: string): string {
  if (!text) return text;
  const lines = text.split("\n");
  const out: string[] = [];
  let inSection = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      inSection = trimmed === `[${section}]`;
      if (!inSection) out.push(line);
      continue;
    }
    if (!inSection) out.push(line);
  }
  while (out.length && out[out.length - 1]?.trim() === "") out.pop();
  return out.join("\n");
}
