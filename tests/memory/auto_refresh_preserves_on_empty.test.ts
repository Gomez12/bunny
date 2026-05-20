/**
 * Auto-refresh handlers must NOT wipe a stored soul/memory body when the LLM
 * returns empty output (blank reply, whitespace-only, parse failure upstream).
 * The auto setters below should leave the content column untouched in that
 * case while still advancing status/watermark/refresh metadata so the row
 * doesn't stay `'refreshing'`.
 *
 * Regression coverage for every auto setter that writes an LLM-generated body:
 *   - users.soul                  (setUserSoulAuto)
 *   - user_project_memory.memory  (setUserProjectMemoryAuto)
 *   - agent_project_memory.memory (setAgentProjectMemoryAuto)
 *   - users.news_soul             (setUserNewsSoulAuto)
 *   - contacts.soul               (setContactSoulAuto)
 *   - businesses.soul             (setBusinessSoulAuto)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../../src/memory/db.ts";
import { createProject } from "../../src/memory/projects.ts";
import { createAgent, linkAgentToProject } from "../../src/memory/agents.ts";
import {
  getUserById,
  setUserSoulAuto,
  claimUserSoulForRefresh,
} from "../../src/auth/users.ts";
import {
  ensureUserProjectMemory,
  getUserProjectMemory,
  setUserProjectMemoryAuto,
  setUserProjectMemoryManual,
} from "../../src/memory/user_project_memory.ts";
import {
  ensureAgentProjectMemory,
  getAgentProjectMemory,
  setAgentProjectMemoryAuto,
  setAgentProjectMemoryManual,
} from "../../src/memory/agent_project_memory.ts";
import {
  getUserNewsSoul,
  setUserNewsSoulAuto,
} from "../../src/memory/news_soul.ts";
import {
  createContact,
  getContact,
  setContactSoulAuto,
  setContactSoulManual,
} from "../../src/memory/contacts.ts";
import {
  createBusiness,
  getBusiness,
  setBusinessSoulAuto,
  setBusinessSoulManual,
} from "../../src/memory/businesses.ts";

let tmp: string;
let db: Database;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "bunny-empty-refresh-"));
  db = await openDb(join(tmp, "db.sqlite"));
  const now = Date.now();
  db.run(
    `INSERT INTO users(id, username, password_hash, role, created_at, updated_at)
     VALUES ('u1', 'alice', 'x', 'user', ?, ?)`,
    [now, now],
  );
  createProject(db, { name: "alpha", createdBy: "u1" });
  createAgent(db, {
    name: "researcher",
    description: "Research agent",
    visibility: "public",
    createdBy: "u1",
  });
  linkAgentToProject(db, "alpha", "researcher");
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("auto setters preserve existing body when LLM returns empty", () => {
  test("setUserSoulAuto keeps existing soul, still advances watermark + status", () => {
    setUserSoulAuto(db, "u1", "knows kubernetes, prefers terse answers", 10);
    expect(claimUserSoulForRefresh(db, "u1")).toBe(true);

    // Empty LLM output must not wipe the soul.
    setUserSoulAuto(db, "u1", "   \n  ", 25);

    const after = getUserById(db, "u1")!;
    expect(after.soul).toBe("knows kubernetes, prefers terse answers");
    expect(after.soulStatus).toBe("idle");
    expect(after.soulWatermarkMessageId).toBe(25);
    expect(after.soulError).toBeNull();
    expect(after.soulRefreshingAt).toBeNull();
  });

  test("setUserProjectMemoryAuto keeps existing memory on empty output", () => {
    setUserProjectMemoryManual(db, "u1", "alpha", "prefers Dutch in chat");
    const before = getUserProjectMemory(db, "u1", "alpha")!;

    setUserProjectMemoryAuto(db, "u1", "alpha", "", 99);

    const after = getUserProjectMemory(db, "u1", "alpha")!;
    expect(after.memory).toBe("prefers Dutch in chat");
    expect(after.watermarkMessageId).toBe(99);
    expect(after.status).toBe("idle");
    expect(after.refreshedAt).not.toBeNull();
    expect(after.manualEditedAt).toBe(before.manualEditedAt);
  });

  test("setAgentProjectMemoryAuto keeps existing memory on empty output", () => {
    setAgentProjectMemoryManual(
      db,
      "researcher",
      "alpha",
      "calls user 'baas'",
    );

    setAgentProjectMemoryAuto(db, "researcher", "alpha", "\t \n", 77);

    const after = getAgentProjectMemory(db, "researcher", "alpha")!;
    expect(after.memory).toBe("calls user 'baas'");
    expect(after.watermarkMessageId).toBe(77);
    expect(after.status).toBe("idle");
  });

  test("setUserNewsSoulAuto keeps existing news_soul on empty output", () => {
    setUserNewsSoulAuto(db, "u1", "likes deep-dive systems posts");
    const before = getUserNewsSoul(db, "u1")!;
    expect(before.soul).toBe("likes deep-dive systems posts");

    setUserNewsSoulAuto(db, "u1", "");

    const after = getUserNewsSoul(db, "u1")!;
    expect(after.soul).toBe("likes deep-dive systems posts");
    expect(after.status).toBe("idle");
  });

  test("setContactSoulAuto keeps existing soul + sources on empty output", () => {
    const c = createContact(db, {
      project: "alpha",
      name: "Alice",
      createdBy: "u1",
    });
    setContactSoulManual(db, c.id, "operator-curated soul");
    // Seed sources via the auto path with non-empty body first.
    setContactSoulAuto(
      db,
      c.id,
      "currently writing about distributed systems",
      [{ url: "https://twitter.com/alice/status/1", fetchedAt: Date.now() }],
      24 * 60 * 60 * 1000,
    );
    const before = getContact(db, c.id)!;
    expect(before.soulSources).toHaveLength(1);

    // Empty body from the LLM — must NOT wipe soul or sources.
    setContactSoulAuto(db, c.id, "   ", [], 24 * 60 * 60 * 1000);

    const after = getContact(db, c.id)!;
    expect(after.soul).toBe(before.soul);
    expect(after.soulSources).toHaveLength(1);
    expect(after.soulStatus).toBe("idle");
    expect(after.soulNextRefreshAt).toBeGreaterThan(0);
  });

  test("setBusinessSoulAuto keeps existing soul + sources on empty output", () => {
    const b = createBusiness(db, {
      project: "alpha",
      name: "Acme",
      createdBy: "u1",
    });
    setBusinessSoulManual(db, b.id, "operator-curated soul");
    setBusinessSoulAuto(
      db,
      b.id,
      "currently shipping product X",
      [{ url: "https://acme.com/blog", fetchedAt: Date.now() }],
      24 * 60 * 60 * 1000,
    );
    const before = getBusiness(db, b.id)!;
    expect(before.soulSources).toHaveLength(1);

    setBusinessSoulAuto(db, b.id, "\n", [], 24 * 60 * 60 * 1000);

    const after = getBusiness(db, b.id)!;
    expect(after.soul).toBe(before.soul);
    expect(after.soulSources).toHaveLength(1);
    expect(after.soulStatus).toBe("idle");
  });
});
