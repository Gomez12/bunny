/**
 * HTTP coverage for /api/config/prompts (admin-only globals) and
 * /api/projects/:name/prompts (admin or project creator).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../../src/memory/db.ts";
import { handleApi, type RouteCtx } from "../../src/server/routes.ts";
import { ensureSeedUsers } from "../../src/auth/seed.ts";
import { createUser } from "../../src/auth/users.ts";
import { createProject } from "../../src/memory/projects.ts";
import type { BunnyConfig } from "../../src/config.ts";
import { __clearGlobalPromptsCache } from "../../src/prompts/global_overrides.ts";
import { __clearProjectPromptsCache } from "../../src/memory/prompt_overrides.ts";

let tmp: string;
let db: Database;
let ctx: RouteCtx;
let adminCookie: string;
let creatorCookie: string;
let viewerCookie: string;
const ORIGINAL_HOME = process.env["BUNNY_HOME"];
const ORIGINAL_CWD = process.cwd();

const cfg: BunnyConfig = {
  llm: {
    baseUrl: "",
    apiKey: "",
    model: "x",
    modelReasoning: undefined,
    profile: undefined,
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
  code: { cloneTimeoutMs: 300_000, maxRepoSizeMb: 500, defaultCloneDepth: 50 },
  sessionId: undefined,
};

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "bunny-prompts-routes-"));
  process.env["BUNNY_HOME"] = tmp;
  process.chdir(tmp);
  __clearGlobalPromptsCache();
  __clearProjectPromptsCache();
  db = await openDb(join(tmp, "test.sqlite"));
  await ensureSeedUsers(db, cfg.auth);
  const creator = await createUser(db, {
    username: "creator",
    password: "pw",
    role: "user",
  });
  await createUser(db, { username: "viewer", password: "pw", role: "user" });
  createProject(db, { name: "alpha", createdBy: creator.id });
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
  creatorCookie = await login("creator", "pw");
  viewerCookie = await login("viewer", "pw");
});

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
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

describe("GET /api/config/prompts", () => {
  test("401 without auth", async () => {
    const { res } = await req("GET", "/api/config/prompts");
    expect(res.status).toBe(401);
  });

  test("403 for non-admin", async () => {
    const { res } = await req("GET", "/api/config/prompts", {
      cookie: viewerCookie,
    });
    expect(res.status).toBe(403);
  });

  test("admin sees every prompt with effective=default when no overrides", async () => {
    const { res, body } = await req("GET", "/api/config/prompts", {
      cookie: adminCookie,
    });
    expect(res.status).toBe(200);
    const prompts = (
      body as {
        prompts: Array<{
          key: string;
          effective: string;
          defaultText: string;
          isOverridden: boolean;
        }>;
      }
    ).prompts;
    expect(prompts.length).toBeGreaterThan(0);
    for (const p of prompts) {
      expect(p.effective).toBe(p.defaultText);
      expect(p.isOverridden).toBe(false);
    }
  });
});

describe("PUT /api/config/prompts", () => {
  test("403 for non-admin", async () => {
    const { res } = await req("PUT", "/api/config/prompts", {
      cookie: viewerCookie,
      body: { key: "kb.definition", text: "hi" },
    });
    expect(res.status).toBe(403);
  });

  test("rejects unknown keys", async () => {
    const { res } = await req("PUT", "/api/config/prompts", {
      cookie: adminCookie,
      body: { key: "does.not.exist", text: "hi" },
    });
    expect(res.status).toBe(400);
  });

  test("sets a global override, GET returns new effective text", async () => {
    const put = await req("PUT", "/api/config/prompts", {
      cookie: adminCookie,
      body: { key: "kb.definition", text: "CUSTOM KB PROMPT" },
    });
    expect(put.res.status).toBe(200);
    const list = await req("GET", "/api/config/prompts", {
      cookie: adminCookie,
    });
    const hit = (
      list.body as {
        prompts: Array<{
          key: string;
          effective: string;
          global: string | null;
          isOverridden: boolean;
        }>;
      }
    ).prompts.find((p) => p.key === "kb.definition")!;
    expect(hit.effective).toBe("CUSTOM KB PROMPT");
    expect(hit.global).toBe("CUSTOM KB PROMPT");
    expect(hit.isOverridden).toBe(true);
    // File landed on disk.
    const toml = readFileSync(join(tmp, "bunny.config.toml"), "utf8");
    expect(toml).toContain('"kb.definition"');
    expect(toml).toContain("CUSTOM KB PROMPT");
  });

  test("text=null clears the override", async () => {
    await req("PUT", "/api/config/prompts", {
      cookie: adminCookie,
      body: { key: "kb.definition", text: "first" },
    });
    const clear = await req("PUT", "/api/config/prompts", {
      cookie: adminCookie,
      body: { key: "kb.definition", text: null },
    });
    expect(clear.res.status).toBe(200);
    const list = await req("GET", "/api/config/prompts", {
      cookie: adminCookie,
    });
    const hit = (
      list.body as {
        prompts: Array<{
          key: string;
          global: string | null;
          isOverridden: boolean;
        }>;
      }
    ).prompts.find((p) => p.key === "kb.definition")!;
    expect(hit.global).toBe(null);
    expect(hit.isOverridden).toBe(false);
  });

  test("preserves other config blocks on write", async () => {
    // Seed an unrelated block, then write a prompt; unrelated block must survive.
    const file = join(tmp, "bunny.config.toml");
    Bun.write(file, `[llm]\nmodel = "gpt-4o"\n`);
    const put = await req("PUT", "/api/config/prompts", {
      cookie: adminCookie,
      body: { key: "kb.definition", text: "X" },
    });
    expect(put.res.status).toBe(200);
    const toml = readFileSync(file, "utf8");
    expect(toml).toContain("[llm]");
    expect(toml).toContain('model = "gpt-4o"');
    expect(toml).toContain("[prompts]");
  });

  test("rejects overly long text", async () => {
    const big = "a".repeat(64 * 1024 + 1);
    const { res } = await req("PUT", "/api/config/prompts", {
      cookie: adminCookie,
      body: { key: "kb.definition", text: big },
    });
    expect(res.status).toBe(413);
  });
});

describe("GET /api/projects/:name/prompts", () => {
  test("401 without auth", async () => {
    const { res } = await req("GET", "/api/projects/alpha/prompts");
    expect(res.status).toBe(401);
  });

  test("viewer (non-creator, non-admin) gets 403", async () => {
    const { res } = await req("GET", "/api/projects/alpha/prompts", {
      cookie: viewerCookie,
    });
    expect(res.status).toBe(403);
  });

  test("project creator can GET", async () => {
    const { res, body } = await req("GET", "/api/projects/alpha/prompts", {
      cookie: creatorCookie,
    });
    expect(res.status).toBe(200);
    const prompts = (body as { prompts: Array<{ key: string; scope: string }> })
      .prompts;
    // Only projectOverridable keys are returned.
    for (const p of prompts) {
      expect(p.scope).toBe("projectOverridable");
    }
  });

  test("admin can GET any project's prompts", async () => {
    const { res } = await req("GET", "/api/projects/alpha/prompts", {
      cookie: adminCookie,
    });
    expect(res.status).toBe(200);
  });

  test("unknown project returns 404", async () => {
    const { res } = await req("GET", "/api/projects/zzzz/prompts", {
      cookie: adminCookie,
    });
    expect(res.status).toBe(404);
  });
});

describe("PUT /api/projects/:name/prompts", () => {
  test("project creator can set + effective reflects override", async () => {
    const put = await req("PUT", "/api/projects/alpha/prompts", {
      cookie: creatorCookie,
      body: { key: "kb.definition", text: "ALPHA KB" },
    });
    expect(put.res.status).toBe(200);
    const list = await req("GET", "/api/projects/alpha/prompts", {
      cookie: creatorCookie,
    });
    const hit = (
      list.body as {
        prompts: Array<{
          key: string;
          override: string | null;
          effective: string;
        }>;
      }
    ).prompts.find((p) => p.key === "kb.definition")!;
    expect(hit.override).toBe("ALPHA KB");
    expect(hit.effective).toBe("ALPHA KB");
  });

  test("project override beats global override", async () => {
    await req("PUT", "/api/config/prompts", {
      cookie: adminCookie,
      body: { key: "kb.definition", text: "GLOBAL" },
    });
    await req("PUT", "/api/projects/alpha/prompts", {
      cookie: adminCookie,
      body: { key: "kb.definition", text: "PROJECT" },
    });
    const list = await req("GET", "/api/projects/alpha/prompts", {
      cookie: adminCookie,
    });
    const hit = (
      list.body as {
        prompts: Array<{
          key: string;
          effective: string;
          global: string | null;
          override: string | null;
        }>;
      }
    ).prompts.find((p) => p.key === "kb.definition")!;
    expect(hit.effective).toBe("PROJECT");
    expect(hit.global).toBe("GLOBAL");
    expect(hit.override).toBe("PROJECT");
  });

  test("non-creator non-admin gets 403 on PUT", async () => {
    const { res } = await req("PUT", "/api/projects/alpha/prompts", {
      cookie: viewerCookie,
      body: { key: "kb.definition", text: "NOPE" },
    });
    expect(res.status).toBe(403);
  });

  test("rejects global-only keys", async () => {
    const { res } = await req("PUT", "/api/projects/alpha/prompts", {
      cookie: adminCookie,
      body: { key: "tools.ask_user.description", text: "x" },
    });
    expect(res.status).toBe(400);
  });

  test("text=null clears the project override", async () => {
    await req("PUT", "/api/projects/alpha/prompts", {
      cookie: adminCookie,
      body: { key: "kb.definition", text: "X" },
    });
    const clear = await req("PUT", "/api/projects/alpha/prompts", {
      cookie: adminCookie,
      body: { key: "kb.definition", text: null },
    });
    expect(clear.res.status).toBe(200);
    const list = await req("GET", "/api/projects/alpha/prompts", {
      cookie: adminCookie,
    });
    const hit = (
      list.body as { prompts: Array<{ key: string; override: string | null }> }
    ).prompts.find((p) => p.key === "kb.definition")!;
    expect(hit.override).toBe(null);
  });
});
