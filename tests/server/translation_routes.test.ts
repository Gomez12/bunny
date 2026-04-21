/**
 * HTTP route tests for /api/projects/:p/translations/:kind/:id/:lang.
 *
 * Covers list (GET), manual trigger (POST), auth, and the guard rails for
 * unsupported languages / wrong project / non-existent entity.
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
import { createDefinition } from "../../src/memory/kb_definitions.ts";
import type { BunnyConfig } from "../../src/config.ts";

let tmp: string;
let db: Database;
let ctx: RouteCtx;
let adminCookie: string;
let userCookie: string;
let outsiderCookie: string;
let defId: number;

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
  agent: { systemPrompt: "", defaultProject: "general", defaultAgent: "bunny" },
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

async function login(user: string, password: string): Promise<string> {
  const res = await handleApi(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: user, password }),
    }),
    new URL("http://localhost/api/auth/login"),
    ctx,
  );
  const setCookie = res.headers.get("Set-Cookie") ?? "";
  const match = setCookie.match(/bunny_session=([^;]+)/);
  if (!match) throw new Error(`login failed for ${user}`);
  return `bunny_session=${match[1]}`;
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "bunny-tr-routes-"));
  db = await openDb(join(tmp, "test.sqlite"));
  await ensureSeedUsers(db, cfg.auth);
  ctx = {
    db,
    cfg,
    queue: { log: async () => {}, close: async () => {} },
    scheduler: {
      tick: async () => {},
      runTask: async () => {},
      stop: () => undefined,
    },
    handlerRegistry: {
      register: () => {},
      get: () => undefined,
      list: () => [],
      unregister: () => {},
      reset: () => {},
    },
  };
  await createUser(db, {
    username: "alice",
    password: "pw-alicepw-123",
    role: "user",
    displayName: "Alice",
  });
  await createUser(db, {
    username: "bob",
    password: "pw-bobpw-123",
    role: "user",
    displayName: "Bob",
  });
  adminCookie = await login("admin", "pw-initial");
  userCookie = await login("alice", "pw-alicepw-123");
  outsiderCookie = await login("bob", "pw-bobpw-123");

  const aliceId = (
    db.prepare(`SELECT id FROM users WHERE username='alice'`).get() as {
      id: string;
    }
  ).id;
  createProject(db, {
    name: "alpha",
    languages: ["en", "nl"],
    defaultLanguage: "en",
    visibility: "public",
    createdBy: aliceId,
  });
  const def = createDefinition(db, {
    project: "alpha",
    term: "Chair",
    manualDescription: "A seat.",
    createdBy: aliceId,
  });
  defId = def.id;
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function req(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  cookie: string,
  body?: unknown,
): Promise<Response> {
  const url = `http://localhost${path}`;
  const init: RequestInit = {
    method,
    headers: { cookie, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
  return handleApi(new Request(url, init), new URL(url), ctx);
}

describe("GET /api/projects/:p/translations/:kind/:id", () => {
  test("returns the sidecar rows created on definition insert", async () => {
    const res = await req(
      "GET",
      `/api/projects/alpha/translations/kb_definition/${defId}`,
      adminCookie,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      kind: string;
      entityId: number;
      projectLanguages: string[];
      translations: Array<{ lang: string; status: string }>;
    };
    expect(body.kind).toBe("kb_definition");
    expect(body.entityId).toBe(defId);
    expect(body.projectLanguages).toEqual(["en", "nl"]);
    expect(body.translations.map((t) => t.lang).sort()).toEqual(["nl"]);
    expect(body.translations[0]!.status).toBe("pending");
  });

  test("non-viewer of a private project gets 403", async () => {
    // Make alpha private.
    db.prepare(
      `UPDATE projects SET visibility='private' WHERE name='alpha'`,
    ).run();
    const res = await req(
      "GET",
      `/api/projects/alpha/translations/kb_definition/${defId}`,
      outsiderCookie,
    );
    expect(res.status).toBe(403);
  });

  test("unknown kind returns 404", async () => {
    const res = await req(
      "GET",
      `/api/projects/alpha/translations/nope/${defId}`,
      adminCookie,
    );
    expect(res.status).toBe(404);
  });

  test("entity not in this project returns 400", async () => {
    const aliceId = (
      db.prepare(`SELECT id FROM users WHERE username='alice'`).get() as {
        id: string;
      }
    ).id;
    createProject(db, {
      name: "beta",
      languages: ["en"],
      defaultLanguage: "en",
      createdBy: aliceId,
    });
    const res = await req(
      "GET",
      `/api/projects/beta/translations/kb_definition/${defId}`,
      adminCookie,
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/projects/:p/translations/:kind/:id/:lang", () => {
  test("flips the sidecar row back to pending for the triggering user", async () => {
    // Pre-seed: mark the 'nl' row as ready so we can observe the flip.
    db.prepare(
      `UPDATE kb_definition_translations SET status='ready' WHERE definition_id = ? AND lang='nl'`,
    ).run(defId);
    const res = await req(
      "POST",
      `/api/projects/alpha/translations/kb_definition/${defId}/nl`,
      userCookie, // alice = creator of the project and the definition
    );
    expect(res.status).toBe(200);
    const row = db
      .prepare(
        `SELECT status FROM kb_definition_translations WHERE definition_id = ? AND lang='nl'`,
      )
      .get(defId) as { status: string };
    expect(row.status).toBe("pending");
  });

  test("rejects unsupported language with 400", async () => {
    const res = await req(
      "POST",
      `/api/projects/alpha/translations/kb_definition/${defId}/de`,
      userCookie,
    );
    expect(res.status).toBe(400);
  });

  test("rejects the source language with 400", async () => {
    const res = await req(
      "POST",
      `/api/projects/alpha/translations/kb_definition/${defId}/en`,
      userCookie,
    );
    expect(res.status).toBe(400);
  });

  test("non-editor gets 403", async () => {
    const res = await req(
      "POST",
      `/api/projects/alpha/translations/kb_definition/${defId}/nl`,
      outsiderCookie,
    );
    expect(res.status).toBe(403);
  });
});
