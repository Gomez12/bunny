import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../../src/memory/db.ts";
import { handleApi, type RouteCtx } from "../../src/server/routes.ts";
import { ensureSeedUsers } from "../../src/auth/seed.ts";
import { createProject } from "../../src/memory/projects.ts";
import {
  createCodeProject,
  getCodeProject,
  setGitReady,
} from "../../src/memory/code_projects.ts";
import type { BunnyConfig } from "../../src/config.ts";

let tmp: string;
let db: Database;
let ctx: RouteCtx;
let adminCookie: string;
let adminId: string;
const ORIGINAL_HOME = process.env["BUNNY_HOME"];

const cfg: BunnyConfig = {
  llm: {
    baseUrl: "",
    apiKey: "",
    model: "x",
    modelReasoning: undefined,
    profile: undefined,
    maxConcurrentRequests: 1,
  },
  embed: { baseUrl: "", apiKey: "", model: "x", dim: 1536 },
  memory: { indexReasoning: false, recallK: 8, lastN: 10 },
  render: { reasoning: "collapsed", color: undefined },
  queue: { topics: [] },
  auth: {
    defaultAdminUsername: "admin",
    defaultAdminPassword: "pw-initial",
    sessionTtlHours: 1,
  },
  agent: {
    systemPrompt: "You are Bunny.",
    defaultProject: "general",
    defaultAgent: "bunny",
  },
  ui: { autosaveIntervalMs: 5000 },
  web: {
    serpApiKey: "",
    serpProvider: "serper",
    serpBaseUrl: "",
    userAgent: "",
  },
  translation: {
    maxPerTick: 20,
    maxDocumentBytes: 30_720,
    stuckThresholdMs: 30 * 60 * 1000,
    systemPrompt: "",
  },
  telegram: {
    pollLeaseMs: 50_000,
    chunkChars: 4000,
    documentFallbackBytes: 16 * 1024,
    publicBaseUrl: "",
  },
  code: {
    cloneTimeoutMs: 300_000,
    maxRepoSizeMb: 500,
    defaultCloneDepth: 50,
    graph: {
      enabled: true,
      timeoutMs: 1_800_000,
      maxFiles: 5000,
      maxFileSizeKb: 512,
      maxDocFiles: 100,
      clusterAlgorithm: "louvain" as const,
      displayMaxNodes: 300,
      docExtractionEnabled: false,
      languages: [
        "ts",
        "tsx",
        "js",
        "jsx",
        "py",
        "go",
        "rs",
        "java",
        "c",
        "cpp",
        "rb",
        "php",
      ],
    },
  },
  workflows: {
    bashEnabled: false,
    bashDefaultTimeoutMs: 120_000,
    bashMaxOutputBytes: 256 * 1024,
    scriptEnabled: false,
    scriptDefaultTimeoutMs: 120_000,
    scriptMaxOutputBytes: 256 * 1024,
    loopDefaultMaxIterations: 10,
  },
  contacts: {
    soulRefreshCron: "0 */6 * * *",
    soulRefreshBatchSize: 5,
    soulRefreshCadenceH: 24,
    soulStuckThresholdMs: 1_800_000,
    translateSoul: true,
  },
  businesses: {
    autoBuildEnabled: false,
    autoBuildCron: "30 */6 * * *",
    autoBuildBatchSize: 3,
    soulRefreshCron: "0 */6 * * *",
    soulRefreshBatchSize: 5,
    soulRefreshCadenceH: 24,
    soulStuckThresholdMs: 1_800_000,
    translateSoul: true,
  },
  sessionId: undefined,
};

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "bunny-code-routes-"));
  process.env["BUNNY_HOME"] = tmp;
  db = await openDb(join(tmp, "test.sqlite"));
  await ensureSeedUsers(db, cfg.auth);
  ctx = {
    db,
    cfg,
    queue: {
      log: () => {},
      close: async () => {},
    } as unknown as RouteCtx["queue"],
    scheduler: {
      stop: () => {},
      tick: async () => {},
      runTask: async () => {},
    },
    handlerRegistry: {
      register: () => {},
      get: () => undefined,
      list: () => [],
      unregister: () => {},
      reset: () => {},
    },
  };
  adminCookie = await login("admin", "pw-initial");
  adminId = (
    db.prepare(`SELECT id FROM users WHERE username = 'admin'`).get() as {
      id: string;
    }
  ).id;
  createProject(db, { name: "alpha" });
});

afterEach(() => {
  db.close();
  if (ORIGINAL_HOME === undefined) delete process.env["BUNNY_HOME"];
  else process.env["BUNNY_HOME"] = ORIGINAL_HOME;
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

async function req(
  method: string,
  path: string,
  opts: { body?: unknown; cookie?: string } = {},
) {
  const headers: Record<string, string> = {};
  if (opts.body) headers["Content-Type"] = "application/json";
  if (opts.cookie) headers["Cookie"] = opts.cookie;
  const r = new Request("http://localhost" + path, {
    method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const res = await handleApi(r, new URL(r.url), ctx);
  const ct = res.headers.get("content-type") ?? "";
  const body = ct.includes("application/json")
    ? await res.json()
    : await res.text();
  return { res, body };
}

async function login(username: string, password: string): Promise<string> {
  const res = await req("POST", "/api/auth/login", {
    body: { username, password },
  });
  const setCookie = res.res.headers.get("set-cookie") ?? "";
  const m = setCookie.match(/bunny_session=([^;]+)/);
  if (!m) throw new Error("no cookie");
  return `bunny_session=${m[1]}`;
}

describe("code routes", () => {
  test("401 without auth", async () => {
    const { res } = await req("GET", "/api/projects/alpha/code");
    expect(res.status).toBe(401);
  });

  test("GET list is empty for a fresh project", async () => {
    const { res, body } = await req("GET", "/api/projects/alpha/code", {
      cookie: adminCookie,
    });
    expect(res.status).toBe(200);
    expect((body as { codeProjects: unknown[] }).codeProjects).toEqual([]);
  });

  test("POST creates a local-only code project and the dir materialises", async () => {
    const { res, body } = await req("POST", "/api/projects/alpha/code", {
      cookie: adminCookie,
      body: { name: "local-only", description: "scratch" },
    });
    expect(res.status).toBe(201);
    const cp = (body as { codeProject: { id: number; name: string } })
      .codeProject;
    expect(cp.name).toBe("local-only");
    // cloneCodeProject runs detached — give it a tick.
    await new Promise((r) => setTimeout(r, 50));
    const row = getCodeProject(db, cp.id);
    expect(row?.gitStatus).toBe("ready");
  });

  test("POST rejects ssh:// and scp-style urls", async () => {
    const ssh = await req("POST", "/api/projects/alpha/code", {
      cookie: adminCookie,
      body: { name: "bad-ssh", gitUrl: "ssh://git@example.com/repo.git" },
    });
    expect(ssh.res.status).toBe(400);

    const scp = await req("POST", "/api/projects/alpha/code", {
      cookie: adminCookie,
      body: { name: "bad-scp", gitUrl: "git@github.com:user/repo.git" },
    });
    expect(scp.res.status).toBe(400);
  });

  test("POST rejects file:// urls", async () => {
    const { res } = await req("POST", "/api/projects/alpha/code", {
      cookie: adminCookie,
      body: { name: "bad-file", gitUrl: "file:///etc/passwd" },
    });
    expect(res.status).toBe(400);
  });

  test("PATCH updates description + gitRef but not name", async () => {
    const cp = createCodeProject(db, {
      project: "alpha",
      name: "editable",
      createdBy: adminId,
    });
    const { res, body } = await req("PATCH", `/api/code/${cp.id}`, {
      cookie: adminCookie,
      body: { description: "new desc", gitRef: "main" },
    });
    expect(res.status).toBe(200);
    const updated = (
      body as {
        codeProject: {
          description: string;
          gitRef: string | null;
          name: string;
        };
      }
    ).codeProject;
    expect(updated.description).toBe("new desc");
    expect(updated.gitRef).toBe("main");
    expect(updated.name).toBe("editable");
  });

  test("DELETE soft-deletes so the row disappears from the list", async () => {
    const cp = createCodeProject(db, {
      project: "alpha",
      name: "gone",
      createdBy: adminId,
    });
    const { res } = await req("DELETE", `/api/code/${cp.id}`, {
      cookie: adminCookie,
    });
    expect(res.status).toBe(200);
    expect(getCodeProject(db, cp.id)).toBeNull();
  });

  test("GET /tree returns entries relative to code project root", async () => {
    const cp = createCodeProject(db, {
      project: "alpha",
      name: "tree",
      createdBy: adminId,
    });
    // Materialise the directory + mark ready.
    await req("POST", `/api/code/${cp.id}/clone`, { cookie: adminCookie });
    await new Promise((r) => setTimeout(r, 50));
    setGitReady(db, cp.id);
    // Drop one file at the root so we see it in the tree.
    const projectDir = join(tmp, "projects", "alpha");
    const codeDir = join(projectDir, "workspace", "code", "tree");
    const fs = await import("node:fs");
    fs.mkdirSync(codeDir, { recursive: true });
    fs.writeFileSync(join(codeDir, "README.md"), "# hi", "utf8");
    const { res, body } = await req("GET", `/api/code/${cp.id}/tree?path=`, {
      cookie: adminCookie,
    });
    expect(res.status).toBe(200);
    const b = body as { entries: Array<{ name: string; path: string }> };
    const names = b.entries.map((e) => e.name);
    expect(names).toContain("README.md");
    // Paths are stripped of the code/<name>/ prefix.
    const readme = b.entries.find((e) => e.name === "README.md");
    expect(readme?.path).toBe("README.md");
  });

  test("POST /clone returns 409 when already cloning", async () => {
    const cp = createCodeProject(db, {
      project: "alpha",
      name: "busy",
      gitUrl: "https://example.org/repo.git",
      createdBy: adminId,
    });
    // Fresh row created with gitUrl starts in 'cloning' already.
    const { res } = await req("POST", `/api/code/${cp.id}/clone`, {
      cookie: adminCookie,
    });
    expect(res.status).toBe(409);
  });
});
