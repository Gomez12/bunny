import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../../src/memory/db.ts";
import { handleApi, type RouteCtx } from "../../src/server/routes.ts";
import { ensureSeedUsers } from "../../src/auth/seed.ts";
import { createUser } from "../../src/auth/users.ts";
import { createProject } from "../../src/memory/projects.ts";
import { createDocument, deleteDocument } from "../../src/memory/documents.ts";
import type { BunnyConfig } from "../../src/config.ts";

let tmp: string;
let db: Database;
let ctx: RouteCtx;
let adminCookie: string;
let userCookie: string;
let adminId: string;

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
  code: { cloneTimeoutMs: 300_000, maxRepoSizeMb: 500, defaultCloneDepth: 50, graph: { enabled: true, timeoutMs: 1_800_000, maxFiles: 5000, maxFileSizeKb: 512, maxDocFiles: 100, clusterAlgorithm: "louvain" as const, displayMaxNodes: 300, docExtractionEnabled: false, languages: ["ts","tsx","js","jsx","py","go","rs","java","c","cpp","rb","php"] } },
  workflows: { bashEnabled: false, bashDefaultTimeoutMs: 120_000, bashMaxOutputBytes: 256 * 1024, scriptEnabled: false, scriptDefaultTimeoutMs: 120_000, scriptMaxOutputBytes: 256 * 1024, loopDefaultMaxIterations: 10 },
  sessionId: undefined,
};

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "bunny-trash-routes-"));
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
  await createUser(db, {
    username: "alice",
    password: "pw-alice",
    role: "user",
  });
  userCookie = await login("alice", "pw-alice");
});

afterEach(() => {
  db.close();
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { res, body: body as any };
}

async function login(username: string, password: string): Promise<string> {
  const res = await req("POST", "/api/auth/login", {
    body: { username, password },
  });
  const setCookie = res.res.headers.get("set-cookie") ?? "";
  const match = setCookie.match(/bunny_session=([^;]+)/);
  if (!match) throw new Error(`no cookie for ${username}`);
  return `bunny_session=${match[1]}`;
}

describe("Trash HTTP surface", () => {
  test("GET /api/trash returns empty when the bin is empty", async () => {
    const { res, body } = await req("GET", "/api/trash", {
      cookie: adminCookie,
    });
    expect(res.status).toBe(200);
    expect(body.items).toEqual([]);
  });

  test("non-admin users get 403 on every trash endpoint", async () => {
    expect(
      (await req("GET", "/api/trash", { cookie: userCookie })).res.status,
    ).toBe(403);
    expect(
      (
        await req("POST", "/api/trash/document/1/restore", {
          cookie: userCookie,
        })
      ).res.status,
    ).toBe(403);
    expect(
      (await req("DELETE", "/api/trash/document/1", { cookie: userCookie })).res
        .status,
    ).toBe(403);
  });

  test("soft-deleted document surfaces in the bin and can be restored", async () => {
    createProject(db, { name: "alpha" });
    const doc = createDocument(db, {
      project: "alpha",
      name: "Plan",
      createdBy: adminId,
    });
    deleteDocument(db, doc.id, adminId);

    // Appears in the bin.
    const list = await req("GET", "/api/trash", { cookie: adminCookie });
    expect(list.res.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({
      kind: "document",
      id: doc.id,
      name: "Plan",
      project: "alpha",
      deletedBy: adminId,
    });

    // Restore.
    const restored = await req(
      "POST",
      `/api/trash/document/${doc.id}/restore`,
      { cookie: adminCookie },
    );
    expect(restored.res.status).toBe(200);
    expect(restored.body.ok).toBe(true);

    // Bin is empty again; doc is live.
    const empty = await req("GET", "/api/trash", { cookie: adminCookie });
    expect(empty.body.items).toEqual([]);
    const live = await req("GET", "/api/projects/alpha/documents", {
      cookie: adminCookie,
    });
    expect(live.res.status).toBe(200);
    expect((live.body.documents as unknown[]).length).toBe(1);
  });

  test("restore returns 409 when the live name is taken", async () => {
    createProject(db, { name: "alpha" });
    const doc = createDocument(db, {
      project: "alpha",
      name: "Plan",
      createdBy: adminId,
    });
    deleteDocument(db, doc.id, adminId);
    // Fresh "Plan" created in the same project — blocks restore.
    createDocument(db, {
      project: "alpha",
      name: "Plan",
      createdBy: adminId,
    });

    const restored = await req(
      "POST",
      `/api/trash/document/${doc.id}/restore`,
      { cookie: adminCookie },
    );
    expect(restored.res.status).toBe(409);
    expect(restored.body.error).toBe("name_conflict");
  });

  test("hard-delete removes the row from the bin", async () => {
    createProject(db, { name: "alpha" });
    const doc = createDocument(db, {
      project: "alpha",
      name: "Plan",
      createdBy: adminId,
    });
    deleteDocument(db, doc.id, adminId);

    const del = await req("DELETE", `/api/trash/document/${doc.id}`, {
      cookie: adminCookie,
    });
    expect(del.res.status).toBe(200);
    expect(del.body.ok).toBe(true);

    const list = await req("GET", "/api/trash", { cookie: adminCookie });
    expect(list.body.items).toEqual([]);
  });

  test("unknown kind returns 400", async () => {
    const res = await req("POST", "/api/trash/cheese/1/restore", {
      cookie: adminCookie,
    });
    expect(res.res.status).toBe(400);
  });
});
