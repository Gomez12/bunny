import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../../src/memory/db.ts";
import { createProject } from "../../src/memory/projects.ts";
import { upsertTelegramConfig } from "../../src/memory/telegram_config.ts";
import {
  consumePendingLink,
  startPendingLink,
} from "../../src/telegram/linking.ts";
import {
  createPendingLink,
  getPendingLink,
} from "../../src/memory/telegram_pending.ts";
import { getLinkByChatId } from "../../src/memory/telegram_links.ts";

let tmp: string;
let db: Database;

function seedUser(db: Database, id: string, username: string) {
  const now = Date.now();
  db.run(
    `INSERT INTO users(id, username, password_hash, role, created_at, updated_at)
     VALUES (?, ?, 'x', 'user', ?, ?)`,
    [id, username, now, now],
  );
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "bunny-tg-linking-"));
  db = await openDb(join(tmp, "test.sqlite"));
  seedUser(db, "u_alice", "alice");
  createProject(db, { name: "alpha", createdBy: "u_alice" });
  createProject(db, { name: "beta", createdBy: "u_alice" });
  upsertTelegramConfig(db, {
    project: "alpha",
    botToken: "fake-alpha-token",
    botUsername: "alpha_bot",
  });
  upsertTelegramConfig(db, {
    project: "beta",
    botToken: "fake-beta-token",
    botUsername: "beta_bot",
  });
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("startPendingLink", () => {
  test("returns a deep link when telegram is configured", () => {
    const out = startPendingLink(db, { userId: "u_alice", project: "alpha" });
    expect(out.botUsername).toBe("alpha_bot");
    expect(out.deepLink).toBe(`https://t.me/alpha_bot?start=${out.token}`);
    expect(out.token.length).toBe(40);
    expect(out.expiresAt).toBeGreaterThan(Date.now());
  });

  test("throws when telegram is not configured for the project", () => {
    db.run(`DELETE FROM project_telegram_config WHERE project = 'alpha'`);
    expect(() =>
      startPendingLink(db, { userId: "u_alice", project: "alpha" }),
    ).toThrow(/not configured/);
  });
});

describe("consumePendingLink", () => {
  test("swaps a fresh token for a user_telegram_links row", () => {
    const { linkToken } = createPendingLink(db, {
      userId: "u_alice",
      project: "alpha",
    });
    const outcome = consumePendingLink(db, {
      project: "alpha",
      chatId: 111,
      token: linkToken,
    });
    expect(outcome.kind).toBe("linked");
    if (outcome.kind !== "linked") return;
    expect(outcome.link.userId).toBe("u_alice");
    expect(outcome.link.chatId).toBe(111);
    // Pending row should be gone.
    expect(getPendingLink(db, linkToken, Date.now())).toBeNull();
    // Real link must be queryable.
    const fresh = getLinkByChatId(db, "alpha", 111);
    expect(fresh?.userId).toBe("u_alice");
  });

  test("returns expired_or_invalid for an unknown token", () => {
    const outcome = consumePendingLink(db, {
      project: "alpha",
      chatId: 111,
      token: "nope",
    });
    expect(outcome.kind).toBe("expired_or_invalid");
  });

  test("returns expired_or_invalid after TTL has passed", () => {
    const now = Date.now();
    const { linkToken } = createPendingLink(db, {
      userId: "u_alice",
      project: "alpha",
      ttlMs: 60_000,
    });
    const outcome = consumePendingLink(db, {
      project: "alpha",
      chatId: 111,
      token: linkToken,
      now: now + 61_000,
    });
    expect(outcome.kind).toBe("expired_or_invalid");
  });

  test("rejects when token was issued for a different project", () => {
    const { linkToken } = createPendingLink(db, {
      userId: "u_alice",
      project: "alpha",
    });
    const outcome = consumePendingLink(db, {
      project: "beta",
      chatId: 222,
      token: linkToken,
    });
    expect(outcome.kind).toBe("wrong_project");
    if (outcome.kind !== "wrong_project") return;
    expect(outcome.expected).toBe("alpha");
    expect(outcome.got).toBe("beta");
    // Token should be consumed (one-shot) even on rejection.
    expect(getPendingLink(db, linkToken, Date.now())).toBeNull();
  });

  test("token can only be consumed once", () => {
    const { linkToken } = createPendingLink(db, {
      userId: "u_alice",
      project: "alpha",
    });
    const first = consumePendingLink(db, {
      project: "alpha",
      chatId: 111,
      token: linkToken,
    });
    expect(first.kind).toBe("linked");
    const second = consumePendingLink(db, {
      project: "alpha",
      chatId: 222,
      token: linkToken,
    });
    expect(second.kind).toBe("expired_or_invalid");
  });
});
