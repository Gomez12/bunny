/**
 * Bunny web server.
 *
 * Serves two things on one port:
 *   - /api/*  — JSON + SSE endpoints backed by `runAgent()` and the SQLite store
 *   - /*      — the built Vite bundle from `web/dist/` (prod only)
 *
 * In dev the Vite dev server on :5173 proxies /api to this server — so during
 * development you don't need to hit this server's static route.
 */

import { mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { loadConfig } from "../config.ts";
import { paths } from "../paths.ts";
import { getDb } from "../memory/db.ts";
import { createBunnyQueue } from "../queue/bunqueue.ts";
import { errorMessage } from "../util/error.ts";
import { safePath } from "../util/path.ts";
import { handleApi, type RouteCtx } from "./routes.ts";
import { webBundle } from "./web_bundle.ts";
import { ensureSeedUsers } from "../auth/seed.ts";
import { ensureProject, validateProjectName } from "../memory/projects.ts";
import { ensureProjectDir } from "../memory/project_assets.ts";
import { defaultHandlerRegistry } from "../scheduler/handlers.ts";
import { startScheduler } from "../scheduler/ticker.ts";
import { computeNextRun } from "../scheduler/cron.ts";
import { ensureSystemTask } from "../memory/scheduled_tasks.ts";
import {
  BOARD_AUTO_RUN_HANDLER,
  registerBoardAutoRun,
} from "../board/auto_run_handler.ts";

const DEFAULT_PORT = 3000;

const CORS_NO_ORIGIN: Record<string, string> = Object.freeze({
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Credentials": "true",
  Vary: "Origin",
});

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  if (!origin) return CORS_NO_ORIGIN;
  return { ...CORS_NO_ORIGIN, "Access-Control-Allow-Origin": origin };
}

const GZIP_MIN_BYTES = 1024;

async function maybeGzip(res: Response, req: Request): Promise<Response> {
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("json") && !ct.includes("text")) return res;
  const ae = req.headers.get("accept-encoding") ?? "";
  if (!ae.includes("gzip")) return res;
  const buf = await res.arrayBuffer();
  if (buf.byteLength < GZIP_MIN_BYTES)
    return new Response(buf, { status: res.status, headers: res.headers });
  const compressed = Bun.gzipSync(new Uint8Array(buf));
  const headers = new Headers(res.headers);
  headers.set("Content-Encoding", "gzip");
  headers.delete("Content-Length");
  return new Response(compressed, { status: res.status, headers });
}

export interface ServeOptions {
  port?: number;
  /** Directory containing the built frontend (index.html + assets). */
  webRoot?: string;
}

/** Parse `--port=NNNN` from argv. Returns the default when absent. */
export function parsePortFlag(argv: readonly string[]): number {
  const flag = argv.find((a) => a.startsWith("--port="));
  return flag ? Number(flag.split("=")[1]) : DEFAULT_PORT;
}

export async function startServer(
  opts: ServeOptions = {},
): Promise<{ stop: () => Promise<void>; url: string }> {
  const cfg = loadConfig();

  const home = paths.home();
  if (!existsSync(home)) mkdirSync(home, { recursive: true });

  const db = await getDb({ embedDim: cfg.embed.dim });
  await ensureSeedUsers(db, cfg.auth);
  // Seed the configured default project (on top of the always-present 'general').
  try {
    const defaultProject = validateProjectName(cfg.agent.defaultProject);
    ensureProject(db, defaultProject);
    ensureProjectDir(defaultProject);
  } catch (e) {
    console.warn("[bunny] invalid [agent].default_project:", errorMessage(e));
  }
  const queue = createBunnyQueue(db);

  registerBoardAutoRun(defaultHandlerRegistry);
  const bootNow = Date.now();
  const boardAutoRunCron = "*/5 * * * *";
  try {
    ensureSystemTask(db, BOARD_AUTO_RUN_HANDLER, {
      name: "Board auto-run scan",
      description:
        "Start cards assigned to an agent in auto-run swimlanes (every 5 minutes).",
      cronExpr: boardAutoRunCron,
      nextRunAt: computeNextRun(boardAutoRunCron, bootNow),
    });
  } catch (e) {
    console.warn(
      "[bunny] failed to seed board.auto_run_scan:",
      errorMessage(e),
    );
  }
  const scheduler = startScheduler({
    db,
    queue,
    cfg,
    registry: defaultHandlerRegistry,
  });

  const ctx: RouteCtx = {
    db,
    queue,
    cfg,
    scheduler,
    handlerRegistry: defaultHandlerRegistry,
  };

  const port = opts.port ?? DEFAULT_PORT;
  const webRoot = opts.webRoot
    ? resolve(opts.webRoot)
    : resolve(process.cwd(), "web/dist");
  const haveStatic = existsSync(webRoot);
  const haveEmbedded = Object.keys(webBundle).length > 0;

  const server = Bun.serve({
    port,
    idleTimeout: 0, // SSE streams can outlive the default idle timeout.
    async fetch(req) {
      const url = new URL(req.url);

      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(req) });
      }

      let res: Response;
      if (url.pathname.startsWith("/api/")) {
        try {
          res = await handleApi(req, url, ctx);
          // Compress JSON API responses (skip SSE streams).
          if (!res.headers.get("content-type")?.includes("event-stream")) {
            res = await maybeGzip(res, req);
          }
        } catch (e) {
          res = new Response(JSON.stringify({ error: errorMessage(e) }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      } else if (haveStatic) {
        res = await serveStatic(url.pathname, webRoot);
      } else if (haveEmbedded) {
        res = await serveEmbedded(url.pathname);
      } else {
        res = new Response(devPlaceholder(), {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      for (const [k, v] of Object.entries(corsHeaders(req))) {
        res.headers.set(k, v);
      }
      return res;
    },
  });

  const baseUrl = `http://localhost:${server.port}`;
  const webHint = haveStatic
    ? "  (serving web/dist)"
    : haveEmbedded
      ? "  (serving embedded web bundle)"
      : "  (no web/dist — run `bun run web:dev` in another terminal)";
  // eslint-disable-next-line no-console
  console.log(`bunny serve → ${baseUrl}${webHint}`);

  return {
    url: baseUrl,
    async stop() {
      scheduler.stop();
      server.stop();
      await queue.close();
    },
  };
}

async function serveEmbedded(pathname: string): Promise<Response> {
  const key = pathname === "/" ? "/index.html" : pathname;
  const embedded = webBundle[key] ?? webBundle["/index.html"];
  if (!embedded) return new Response("not found", { status: 404 });
  return new Response(Bun.file(embedded));
}

async function serveStatic(pathname: string, root: string): Promise<Response> {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");

  let filePath: string;
  try {
    filePath = safePath(rel, root);
  } catch {
    return new Response("forbidden", { status: 403 });
  }

  const file = Bun.file(filePath);
  if (await file.exists()) {
    const headers: Record<string, string> = rel.startsWith("assets/")
      ? { "Cache-Control": "public, max-age=31536000, immutable" }
      : { "Cache-Control": "no-cache" };
    return new Response(file, { headers });
  }

  // SPA fallback — let React Router handle unknown paths.
  const index = Bun.file(join(root, "index.html"));
  if (await index.exists())
    return new Response(index, { headers: { "Cache-Control": "no-cache" } });
  return new Response("not found", { status: 404 });
}

function devPlaceholder(): string {
  return `<!doctype html><html><body style="font-family:system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#222">
<h1>Bunny server is running</h1>
<p>No <code>web/dist/</code> bundle found. Run the Vite dev server:</p>
<pre>cd web && bun install &amp;&amp; bun run dev</pre>
<p>…and open <a href="http://localhost:5173">http://localhost:5173</a>. The dev server proxies <code>/api</code> to this process.</p>
</body></html>`;
}

if (import.meta.main) {
  await startServer({ port: parsePortFlag(process.argv) });
}
