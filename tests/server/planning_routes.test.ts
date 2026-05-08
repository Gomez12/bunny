import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../../src/memory/db.ts";
import { handleApi, type RouteCtx } from "../../src/server/routes.ts";
import { ensureSeedUsers } from "../../src/auth/seed.ts";
import { createProject } from "../../src/memory/projects.ts";
import type { BunnyConfig } from "../../src/config.ts";

let tmp: string;
let db: Database;
let ctx: RouteCtx;
let adminCookie: string;

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
      languages: ["ts"],
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
    whisperTimeoutMs: 300000,
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
  tmp = mkdtempSync(join(tmpdir(), "bunny-planning-routes-"));
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
  createProject(db, { name: "alpha" });
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
  return { res, body };
}

async function login(username: string, password: string): Promise<string> {
  const r = await req("POST", "/api/auth/login", {
    body: { username, password },
  });
  const setCookie = r.res.headers.get("set-cookie") ?? "";
  const m = setCookie.match(/bunny_session=([^;]+)/);
  if (!m) throw new Error("no session cookie returned");
  return `bunny_session=${m[1]}`;
}

describe("planning routes", () => {
  test("401 without auth on list", async () => {
    const { res } = await req("GET", "/api/projects/alpha/planning");
    expect(res.status).toBe(401);
  });

  test("create + list + delete planning project", async () => {
    const created = await req("POST", "/api/projects/alpha/planning", {
      cookie: adminCookie,
      body: { name: "q1", description: "First quarter" },
    });
    expect(created.res.status).toBe(201);
    const pp = (created.body as { planningProject: { id: number } })
      .planningProject;
    const list = await req("GET", "/api/projects/alpha/planning", {
      cookie: adminCookie,
    });
    expect(list.res.status).toBe(200);
    expect(
      (list.body as { planningProjects: { id: number }[] }).planningProjects,
    ).toHaveLength(1);
    const del = await req("DELETE", `/api/planning/${pp.id}`, {
      cookie: adminCookie,
    });
    expect(del.res.status).toBe(200);
  });

  test("rejects malformed slug names", async () => {
    const r = await req("POST", "/api/projects/alpha/planning", {
      cookie: adminCookie,
      body: { name: "../escape" },
    });
    expect(r.res.status).toBe(400);
  });

  test("full happy path: create wishes + generate suggestion + apply", async () => {
    // 1. Planning project.
    const planning = (
      (
        await req("POST", "/api/projects/alpha/planning", {
          cookie: adminCookie,
          body: { name: "q1", startDate: "2026-01-05" },
        })
      ).body as { planningProject: { id: number } }
    ).planningProject;

    // 2. Team.
    const team = (
      (
        await req("POST", `/api/planning/${planning.id}/teams`, {
          cookie: adminCookie,
          body: { name: "backend", maxParallel: 1 },
        })
      ).body as { team: { id: number } }
    ).team;

    // 3. Two wishes that should be sequential due to team_max=1.
    const wish1 = (
      (
        await req("POST", `/api/planning/${planning.id}/wishes`, {
          cookie: adminCookie,
          body: { title: "Set up DB", durationDays: 2, teamId: team.id },
        })
      ).body as { wish: { id: number } }
    ).wish;
    const wish2 = (
      (
        await req("POST", `/api/planning/${planning.id}/wishes`, {
          cookie: adminCookie,
          body: { title: "Add auth", durationDays: 3, teamId: team.id },
        })
      ).body as { wish: { id: number } }
    ).wish;

    // 4. Generate suggestion.
    const gen = await req(
      "POST",
      `/api/planning/${planning.id}/suggestion/generate`,
      { cookie: adminCookie },
    );
    expect(gen.res.status).toBe(200);
    const suggestion = (gen.body as { suggestion: { payload: { placements: { wishId: number; start: string; end: string }[] } } }).suggestion;
    expect(suggestion.payload.placements.length).toBe(2);

    // 5. Apply.
    const apply = await req(
      "POST",
      `/api/planning/${planning.id}/suggestion/apply`,
      { cookie: adminCookie, body: { comment: "ok" } },
    );
    expect(apply.res.status).toBe(200);

    // 6. Wishes now have planned_start_date / planned_end_date.
    const list = await req("GET", `/api/planning/${planning.id}/wishes`, {
      cookie: adminCookie,
    });
    const wishes = (
      list.body as {
        wishes: { id: number; plannedStartDate: string | null; plannedEndDate: string | null }[];
      }
    ).wishes;
    const w1 = wishes.find((w) => w.id === wish1.id)!;
    const w2 = wishes.find((w) => w.id === wish2.id)!;
    expect(w1.plannedStartDate).not.toBeNull();
    expect(w2.plannedStartDate).not.toBeNull();
    // Sequential: w1.end < w2.start.
    expect(w2.plannedStartDate! > w1.plannedEndDate!).toBe(true);

    // 7. Pending suggestion is consumed; report endpoint still answers.
    const pending = await req(
      "GET",
      `/api/planning/${planning.id}/suggestion`,
      { cookie: adminCookie },
    );
    expect((pending.body as { suggestion: unknown }).suggestion).toBeNull();

    const report = await req("GET", `/api/planning/${planning.id}/report`, {
      cookie: adminCookie,
    });
    expect(report.res.status).toBe(200);
    // No deadline set → no overrun.
    expect(
      (report.body as { bottlenecks: unknown[] }).bottlenecks.length,
    ).toBe(0);
  });

  test("report generate + history + markdown export", async () => {
    const planning = (
      (
        await req("POST", "/api/projects/alpha/planning", {
          cookie: adminCookie,
          body: { name: "rpt-q1", startDate: "2026-01-05" },
        })
      ).body as { planningProject: { id: number } }
    ).planningProject;
    await req("POST", `/api/planning/${planning.id}/wishes`, {
      cookie: adminCookie,
      body: { title: "Sample", durationDays: 2 },
    });

    // No history yet.
    const initial = await req(
      "GET",
      `/api/planning/${planning.id}/report/latest`,
      { cookie: adminCookie },
    );
    expect((initial.body as { report: unknown }).report).toBeNull();

    // Generate creates a row.
    const gen = await req(
      "POST",
      `/api/planning/${planning.id}/report/generate`,
      { cookie: adminCookie },
    );
    expect(gen.res.status).toBe(201);
    const reportId = (gen.body as { report: { id: number } }).report.id;
    expect(reportId).toBeGreaterThan(0);

    // Latest now returns it.
    const latest = await req(
      "GET",
      `/api/planning/${planning.id}/report/latest`,
      { cookie: adminCookie },
    );
    expect(
      (latest.body as { report: { id: number } }).report.id,
    ).toBe(reportId);

    // History list contains it.
    const list = await req("GET", `/api/planning/${planning.id}/reports`, {
      cookie: adminCookie,
    });
    expect(
      (list.body as { reports: { id: number }[] }).reports.length,
    ).toBeGreaterThan(0);

    // Generate a second time → comparison populated.
    const gen2 = await req(
      "POST",
      `/api/planning/${planning.id}/report/generate`,
      { cookie: adminCookie },
    );
    const r2 = (
      gen2.body as {
        report: {
          id: number;
          payload: { comparison?: { previousReportId: number } };
        };
      }
    ).report;
    expect(r2.payload.comparison).toBeDefined();
    expect(r2.payload.comparison!.previousReportId).toBe(reportId);

    // Markdown export returns a downloadable plain-text body with headers.
    const mdReq = new Request(
      `http://localhost/api/planning-reports/${reportId}/markdown`,
      { headers: { Cookie: adminCookie } },
    );
    const mdResponse = await handleApi(mdReq, new URL(mdReq.url), ctx);
    expect(mdResponse.status).toBe(200);
    expect(mdResponse.headers.get("content-type") ?? "").toContain(
      "text/markdown",
    );
    const md = await mdResponse.text();
    expect(md).toContain("# Roadmap status —");
  });

  test("advice-hide filters matching pending placement and re-surfaces on change", async () => {
    const planning = (
      (
        await req("POST", "/api/projects/alpha/planning", {
          cookie: adminCookie,
          body: { name: "hide-q1", startDate: "2026-01-05" },
        })
      ).body as { planningProject: { id: number } }
    ).planningProject;
    const wish = (
      (
        await req("POST", `/api/planning/${planning.id}/wishes`, {
          cookie: adminCookie,
          body: { title: "Hide me", durationDays: 2 },
        })
      ).body as { wish: { id: number } }
    ).wish;

    // Generate the suggestion and capture the proposed placement.
    await req("POST", `/api/planning/${planning.id}/suggestion/generate`, {
      cookie: adminCookie,
    });
    const initial = await req(
      "GET",
      `/api/planning/${planning.id}/suggestion`,
      { cookie: adminCookie },
    );
    const placement = (
      initial.body as {
        suggestion: { payload: { placements: Array<{ wishId: number; start: string; end: string }> } };
      }
    ).suggestion.payload.placements.find((p) => p.wishId === wish.id);
    expect(placement).toBeDefined();

    // Hide that exact placement on the wish.
    const hideRes = await req(
      "POST",
      `/api/planning-wishes/${wish.id}/advice-hide`,
      {
        cookie: adminCookie,
        body: { start: placement!.start, end: placement!.end, teamId: null },
      },
    );
    expect(hideRes.res.status).toBe(200);

    // Refetch the suggestion — placement should now be hidden.
    const after = await req(
      "GET",
      `/api/planning/${planning.id}/suggestion`,
      { cookie: adminCookie },
    );
    const sug = (
      after.body as {
        suggestion: {
          payload: {
            placements: Array<{ wishId: number }>;
            hiddenPlacements?: Array<{ wishId: number }>;
          };
        };
      }
    ).suggestion;
    expect(sug.payload.placements.find((p) => p.wishId === wish.id)).toBeUndefined();
    expect(
      sug.payload.hiddenPlacements?.find((p) => p.wishId === wish.id),
    ).toBeDefined();

    // Clear the hide → reappears as visible.
    const clearRes = await req(
      "DELETE",
      `/api/planning-wishes/${wish.id}/advice-hide`,
      { cookie: adminCookie },
    );
    expect(clearRes.res.status).toBe(200);
    const final = await req(
      "GET",
      `/api/planning/${planning.id}/suggestion`,
      { cookie: adminCookie },
    );
    const sug2 = (
      final.body as {
        suggestion: {
          payload: {
            placements: Array<{ wishId: number }>;
            hiddenPlacements?: Array<{ wishId: number }>;
          };
        };
      }
    ).suggestion;
    expect(sug2.payload.placements.find((p) => p.wishId === wish.id)).toBeDefined();
  });

  test("generate flags deadline overrun", async () => {
    const planning = (
      (
        await req("POST", "/api/projects/alpha/planning", {
          cookie: adminCookie,
          body: { name: "tight", startDate: "2026-01-05" },
        })
      ).body as { planningProject: { id: number } }
    ).planningProject;
    const dl = (
      (
        await req("POST", `/api/planning/${planning.id}/deadlines`, {
          cookie: adminCookie,
          body: { name: "Launch", dueDate: "2026-01-06" },
        })
      ).body as { deadline: { id: number } }
    ).deadline;
    await req("POST", `/api/planning/${planning.id}/wishes`, {
      cookie: adminCookie,
      body: {
        title: "Big task",
        durationDays: 5,
        deadlineId: dl.id,
      },
    });
    const gen = await req(
      "POST",
      `/api/planning/${planning.id}/suggestion/generate`,
      { cookie: adminCookie },
    );
    const suggestion = (
      gen.body as {
        suggestion: { payload: { bottlenecks: { kind: string }[] } };
      }
    ).suggestion;
    expect(
      suggestion.payload.bottlenecks.find(
        (b) => b.kind === "deadline_overrun",
      ),
    ).toBeDefined();
  });
});
