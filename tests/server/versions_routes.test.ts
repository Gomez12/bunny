/**
 * HTTP surface for `/api/versions/:kind/:entityId/...`. Phase 3 ships
 * admin-only access; this suite exercises the four endpoints (list / count /
 * detail / restore) end-to-end through `handleApi` to guarantee:
 *
 *   - non-admins get 403 across the namespace,
 *   - unknown kinds return 400 (not 500),
 *   - list/count/detail reflect rows written via `recordVersion`,
 *   - restore reverts the live row and appends a `pre_restore` marker.
 */

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
import {
  createDocument,
  getDocument,
  updateDocument,
} from "../../src/memory/documents.ts";
import {
  configureVersioning,
  recordVersion,
} from "../../src/memory/versioning.ts";
import type { BunnyConfig } from "../../src/config.ts";

let tmp: string;
let db: Database;
let ctx: RouteCtx;
let adminCookie: string;
let userCookie: string;
let adminId: string;

// Minimal config — reuses the same trimmed shape the trash-routes test relies
// on. Routes under `/api/versions` don't read most of these.
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
  web: { serpApiKey: "", serpProvider: "serper", serpBaseUrl: "", userAgent: "" },
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
      languages: ["ts", "tsx", "js"],
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
  scripts: {
    bunPath: "",
    dotnetPath: "",
    pythonPath: "",
    powershellPath: "",
    goPath: "",
    execTimeoutMs: 30_000,
    maxOutputBytes: 10_485_760,
    maxVersionsPerScript: 50,
    syncCron: "*/5 * * * *",
  },
  diary: {
    whisperCppPath: "",
    whisperModelPath: "",
    whisperLanguage: "nl",
    whisperTimeoutMs: 300_000,
  },
  planning: {
    suggestionRefreshCron: "*/5 * * * *",
    suggestionRefreshBatchSize: 5,
    notifyDeadlineConflictDedupMs: 86_400_000,
    reportSnapshotCron: "0 8 * * 1",
    reportSnapshotEnabled: true,
    maxReportsPerProject: 50,
  },
  calendar: { countryCode: "NL" },
  sessionId: undefined,
};

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "bunny-versions-routes-"));
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
  // Same trick the cluster-2x suites use — without it back-to-back saves
  // would debounce into one row and the count/list assertions would lie.
  configureVersioning({ debounceMinutes: 0, maxSnapshotBytes: 1_048_576 });
});

afterEach(() => {
  configureVersioning({ debounceMinutes: 5, maxSnapshotBytes: 1_048_576 });
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
  return { res, body: body as Record<string, unknown> };
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

async function seedDocumentWithVersions(opts?: {
  projectVisibility?: "public" | "private";
}): Promise<number> {
  createProject(db, {
    name: "alpha",
    visibility: opts?.projectVisibility ?? "public",
    createdBy: adminId,
  });
  const doc = createDocument(db, {
    project: "alpha",
    name: "Plan",
    contentMd: "# v1",
    createdBy: adminId,
  });
  recordVersion(db, "document", doc.id, "save", adminId);
  updateDocument(db, doc.id, { name: "Plan v2", contentMd: "# v2" });
  recordVersion(db, "document", doc.id, "save", adminId);
  return doc.id;
}

describe("/api/versions HTTP surface", () => {
  test("non-admins are denied on private-project entities they don't own", async () => {
    // Documents delegate canSee/canEdit to projectScopedAccess. The seed
    // project is private + owned by admin, so alice (a regular user) must
    // be blocked on every endpoint in the namespace.
    const id = await seedDocumentWithVersions({
      projectVisibility: "private",
    });
    expect(
      (await req("GET", `/api/versions/document/${id}`, { cookie: userCookie }))
        .res.status,
    ).toBe(403);
    expect(
      (
        await req("GET", `/api/versions/document/${id}/count`, {
          cookie: userCookie,
        })
      ).res.status,
    ).toBe(403);
    expect(
      (
        await req("POST", `/api/versions/document/${id}/restore`, {
          cookie: userCookie,
          body: { version: 1 },
        })
      ).res.status,
    ).toBe(403);
  });

  test("non-admins can read versions in a public project (but not restore)", async () => {
    // A non-admin user can SEE history of a public-project entity even
    // though they don't own the project — matches the existing
    // canSeeProject(public → everyone) semantics.
    const id = await seedDocumentWithVersions({
      projectVisibility: "public",
    });
    const list = await req("GET", `/api/versions/document/${id}`, {
      cookie: userCookie,
    });
    expect(list.res.status).toBe(200);

    // Restore demands canEdit, which only the project creator (admin here)
    // passes. Alice is read-only.
    const restored = await req(
      "POST",
      `/api/versions/document/${id}/restore`,
      { cookie: userCookie, body: { version: 1 } },
    );
    expect(restored.res.status).toBe(403);
  });

  test("unknown kind returns 400 (not 500)", async () => {
    const r = await req("GET", "/api/versions/not_a_kind/123", {
      cookie: adminCookie,
    });
    expect(r.res.status).toBe(400);
    expect(r.body["error"]).toBe("unknown kind");
  });

  test("__test__ sentinel is refused even when present in registry", async () => {
    // The versioning module ships a `__test__` sentinel in its kind union but
    // the route layer must refuse it so a leaked test registration can't be
    // hit from a production-running process.
    const r = await req("GET", "/api/versions/__test__/1", {
      cookie: adminCookie,
    });
    expect(r.res.status).toBe(400);
  });

  test("list + count + detail reflect recorded versions", async () => {
    const id = await seedDocumentWithVersions();
    const list = await req("GET", `/api/versions/document/${id}`, {
      cookie: adminCookie,
    });
    expect(list.res.status).toBe(200);
    const versions = list.body["versions"] as Array<{
      version: number;
      source: string;
    }>;
    expect(versions.map((v) => v.version)).toEqual([2, 1]);

    const count = await req("GET", `/api/versions/document/${id}/count`, {
      cookie: adminCookie,
    });
    expect(count.body["count"]).toBe(2);

    const detail = await req("GET", `/api/versions/document/${id}/1`, {
      cookie: adminCookie,
    });
    expect(detail.res.status).toBe(200);
    const snap = (
      detail.body["version"] as { snapshot: Record<string, unknown> | null }
    ).snapshot;
    expect(snap?.["name"]).toBe("Plan");
    expect(snap?.["content_md"]).toBe("# v1");
  });

  test("restore endpoint reverts the live row and appends pre_restore", async () => {
    const id = await seedDocumentWithVersions();
    const restored = await req("POST", `/api/versions/document/${id}/restore`, {
      cookie: adminCookie,
      body: { version: 1 },
    });
    expect(restored.res.status).toBe(200);
    expect(restored.body["ok"]).toBe(true);

    const live = getDocument(db, id)!;
    expect(live.name).toBe("Plan");
    expect(live.contentMd).toBe("# v1");

    // The chain now has [pre_restore, save, save].
    const list = await req("GET", `/api/versions/document/${id}`, {
      cookie: adminCookie,
    });
    const sources = (list.body["versions"] as Array<{ source: string }>).map(
      (v) => v.source,
    );
    expect(sources).toEqual(["pre_restore", "save", "save"]);
  });

  test("restore with missing/invalid version returns 400", async () => {
    const id = await seedDocumentWithVersions();
    const r = await req("POST", `/api/versions/document/${id}/restore`, {
      cookie: adminCookie,
      body: {},
    });
    expect(r.res.status).toBe(400);
    expect(String(r.body["error"])).toMatch(/version/);
  });

  test("restore of unknown version returns 404", async () => {
    const id = await seedDocumentWithVersions();
    const r = await req("POST", `/api/versions/document/${id}/restore`, {
      cookie: adminCookie,
      body: { version: 99 },
    });
    expect(r.res.status).toBe(404);
  });
});
