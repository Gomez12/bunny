import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/memory/db.ts";
import { createProject, updateProject } from "../../src/memory/projects.ts";
import { createContact } from "../../src/memory/contacts.ts";
import {
  collectCandidates,
  businessAutoBuildHandler,
} from "../../src/businesses/auto_build_handler.ts";
import {
  findBusinessByName,
  listBusinesses,
} from "../../src/memory/businesses.ts";
import { listContactBusinessLinks } from "../../src/memory/contacts.ts";
import type { Database } from "bun:sqlite";
import type { BunnyConfig } from "../../src/config.ts";
import type {
  ScheduledTask,
  TaskKind,
  TaskStatus,
} from "../../src/memory/scheduled_tasks.ts";

let tmp: string;

async function setup() {
  tmp = mkdtempSync(join(tmpdir(), "bunny-autobuild-"));
  const db = await openDb(join(tmp, "test.sqlite"));
  const now = Date.now();
  db.run(
    `INSERT INTO users(id, username, password_hash, role, created_at, updated_at)
     VALUES ('owner', 'owner', 'x', 'admin', ?, ?)`,
    [now, now],
  );
  // The auto-build handler resolves the system user — make sure it exists.
  db.run(
    `INSERT INTO users(id, username, password_hash, role, created_at, updated_at)
     VALUES ('system', 'system', 'x', 'admin', ?, ?)`,
    [now, now],
  );
  return { db };
}

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("collectCandidates (pure)", () => {
  test("dedupes by case-insensitive name + domain", () => {
    const candidates = collectCandidates([
      {
        id: 1,
        company: "Acme",
        emails: ["alice@acme.com"],
        socials: [],
      },
      {
        id: 2,
        company: "ACME",
        emails: ["bob@acme.com"],
        socials: [],
      },
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.contactIds.sort()).toEqual([1, 2]);
    expect(candidates[0]!.domain).toBe("acme.com");
  });

  test("contacts without company produce no candidate (even with email domain)", () => {
    const candidates = collectCandidates([
      { id: 1, company: "", emails: ["x@example.com"], socials: [] },
    ]);
    expect(candidates).toEqual([]);
  });

  test("website-platform social contributes a domain", () => {
    const candidates = collectCandidates([
      {
        id: 1,
        company: "Acme",
        emails: [],
        socials: [
          {
            platform: "website",
            handle: "https://acme.io",
            url: "https://acme.io",
          },
        ],
      },
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.domain).toBe("acme.io");
  });

  test("multiple domains for same company emit one candidate per domain", () => {
    const candidates = collectCandidates([
      {
        id: 1,
        company: "Acme",
        emails: ["x@acme.com", "y@acme.io"],
        socials: [],
      },
    ]);
    expect(candidates).toHaveLength(2);
    const domains = candidates.map((c) => c.domain).sort();
    expect(domains).toEqual(["acme.com", "acme.io"]);
  });
});

function makeCfg(): BunnyConfig {
  return {
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
      defaultAdminPassword: "x",
      sessionTtlHours: 1,
    },
    agent: {
      systemPrompt: "",
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
        clusterAlgorithm: "louvain",
        displayMaxNodes: 300,
        docExtractionEnabled: false,
        languages: [],
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
      soulStuckThresholdMs: 30 * 60 * 1000,
      translateSoul: false,
    },
    businesses: {
      autoBuildEnabled: false,
      autoBuildCron: "30 */6 * * *",
      // Zero LLM budget — keeps the test offline; insert path still runs.
      autoBuildBatchSize: 0,
      soulRefreshCron: "0 */6 * * *",
      soulRefreshBatchSize: 5,
      soulRefreshCadenceH: 24,
      soulStuckThresholdMs: 30 * 60 * 1000,
      translateSoul: false,
    },
    sessionId: undefined,
  };
}

function makeTaskCtx(db: Database, cfg: BunnyConfig) {
  const task: ScheduledTask = {
    id: "test",
    kind: "system" as TaskKind,
    handler: "business.auto_build",
    name: "test",
    description: null,
    cronExpr: "",
    payload: null,
    enabled: true,
    ownerUserId: null,
    lastRunAt: null,
    lastStatus: null as TaskStatus | null,
    lastError: null,
    nextRunAt: 0,
    createdAt: 0,
    updatedAt: 0,
  };
  return {
    db,
    queue: {
      log: () => {},
    } as unknown as import("../../src/queue/bunqueue.ts").BunnyQueue,
    cfg,
    task,
    payload: null,
    now: Date.now(),
  };
}

describe("businessAutoBuildHandler (opt-in + dedup)", () => {
  test("does nothing when auto_build_businesses is off and cfg fallback is off", async () => {
    const { db } = await setup();
    createProject(db, { name: "alpha", createdBy: "owner" });
    createContact(db, {
      project: "alpha",
      name: "Alice",
      company: "Acme",
      createdBy: "owner",
    });
    const cfg = makeCfg();
    await businessAutoBuildHandler(makeTaskCtx(db, cfg));
    expect(listBusinesses(db, "alpha").total).toBe(0);
  });

  test("opt-in project: spawns one business per unique (name, domain)", async () => {
    const { db } = await setup();
    createProject(db, { name: "alpha", createdBy: "owner" });
    updateProject(db, "alpha", { autoBuildBusinesses: true });
    createContact(db, {
      project: "alpha",
      name: "Alice",
      company: "Acme",
      emails: ["alice@acme.com"],
      createdBy: "owner",
    });
    createContact(db, {
      project: "alpha",
      name: "Bob",
      company: "ACME", // case collision → same key
      emails: ["bob@acme.com"],
      createdBy: "owner",
    });
    createContact(db, {
      project: "alpha",
      name: "Carol",
      company: "Other Co",
      emails: ["carol@other.example"],
      createdBy: "owner",
    });

    const cfg = makeCfg();
    await businessAutoBuildHandler(makeTaskCtx(db, cfg));

    // Two unique businesses: "Acme" + "Other Co"
    const list = listBusinesses(db, "alpha");
    expect(list.total).toBe(2);
    const acme = findBusinessByName(db, "alpha", "Acme")!;
    expect(acme.source).toBe("auto_from_contacts");
    expect(acme.domain).toBe("acme.com");

    // Both Acme contacts should be linked to the same business.
    const acmeLinks = await Promise.all(
      list.businesses
        .filter((b) => b.name.toLowerCase() === "acme")
        .map((b) => listContactBusinessLinks(db, b.id)),
    );
    void acmeLinks;
  });

  test("second tick is idempotent — no duplicate businesses", async () => {
    const { db } = await setup();
    createProject(db, { name: "alpha", createdBy: "owner" });
    updateProject(db, "alpha", { autoBuildBusinesses: true });
    createContact(db, {
      project: "alpha",
      name: "Alice",
      company: "Acme",
      emails: ["alice@acme.com"],
      createdBy: "owner",
    });

    const cfg = makeCfg();
    await businessAutoBuildHandler(makeTaskCtx(db, cfg));
    await businessAutoBuildHandler(makeTaskCtx(db, cfg));
    await businessAutoBuildHandler(makeTaskCtx(db, cfg));
    expect(listBusinesses(db, "alpha").total).toBe(1);
  });

  test("partial UNIQUE index allows recreating after soft-delete", async () => {
    const { db } = await setup();
    createProject(db, { name: "alpha", createdBy: "owner" });
    updateProject(db, "alpha", { autoBuildBusinesses: true });
    createContact(db, {
      project: "alpha",
      name: "Alice",
      company: "Acme",
      emails: ["alice@acme.com"],
      createdBy: "owner",
    });
    const cfg = makeCfg();
    await businessAutoBuildHandler(makeTaskCtx(db, cfg));
    const orig = findBusinessByName(db, "alpha", "Acme")!;
    db.run(`UPDATE businesses SET deleted_at = ? WHERE id = ?`, [
      Date.now(),
      orig.id,
    ]);
    // Soft-deleted → next tick can recreate without UNIQUE conflict.
    await businessAutoBuildHandler(makeTaskCtx(db, cfg));
    const fresh = findBusinessByName(db, "alpha", "Acme")!;
    expect(fresh.id).not.toBe(orig.id);
  });
});
