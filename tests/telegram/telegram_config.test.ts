import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../../src/memory/db.ts";
import { createProject } from "../../src/memory/projects.ts";
import {
  advanceLastUpdateId,
  claimPollLease,
  deleteTelegramConfig,
  getTelegramConfig,
  listEnabledPollConfigs,
  patchTelegramConfig,
  releasePollLease,
  upsertTelegramConfig,
} from "../../src/memory/telegram_config.ts";

let tmp: string;
let db: Database;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "bunny-tg-config-"));
  db = await openDb(join(tmp, "test.sqlite"));
  createProject(db, { name: "alpha", createdBy: null });
  createProject(db, { name: "beta", createdBy: null });
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("upsertTelegramConfig", () => {
  test("creates a new row on first call, updates on second", () => {
    const first = upsertTelegramConfig(db, {
      project: "alpha",
      botToken: "tok1",
      botUsername: "bot1",
    });
    expect(first.transport).toBe("poll");
    expect(first.enabled).toBe(true);
    expect(first.webhookSecret).toBeNull();

    const second = upsertTelegramConfig(db, {
      project: "alpha",
      botToken: "tok2",
      botUsername: "bot2",
      transport: "webhook",
      webhookSecret: "s3cr3t",
    });
    expect(second.botToken).toBe("tok2");
    expect(second.transport).toBe("webhook");
    expect(second.webhookSecret).toBe("s3cr3t");
  });

  test("enforces UNIQUE(bot_token) across projects", () => {
    upsertTelegramConfig(db, {
      project: "alpha",
      botToken: "same",
      botUsername: "a_bot",
    });
    expect(() =>
      upsertTelegramConfig(db, {
        project: "beta",
        botToken: "same",
        botUsername: "b_bot",
      }),
    ).toThrow();
  });
});

describe("patch + delete", () => {
  test("patch updates only provided fields", () => {
    upsertTelegramConfig(db, {
      project: "alpha",
      botToken: "tok1",
      botUsername: "bot1",
    });
    const out = patchTelegramConfig(db, "alpha", { enabled: false });
    expect(out.enabled).toBe(false);
    expect(out.botToken).toBe("tok1");
  });

  test("delete removes the row", () => {
    upsertTelegramConfig(db, {
      project: "alpha",
      botToken: "tok1",
      botUsername: "bot1",
    });
    deleteTelegramConfig(db, "alpha");
    expect(getTelegramConfig(db, "alpha")).toBeNull();
  });
});

describe("claimPollLease + listEnabledPollConfigs", () => {
  test("lists only enabled poll-mode rows whose lease has lapsed", () => {
    upsertTelegramConfig(db, {
      project: "alpha",
      botToken: "ta",
      botUsername: "a_bot",
    });
    upsertTelegramConfig(db, {
      project: "beta",
      botToken: "tb",
      botUsername: "b_bot",
      enabled: false, // disabled
    });
    // Create a third config in webhook mode.
    createProject(db, { name: "gamma", createdBy: null });
    upsertTelegramConfig(db, {
      project: "gamma",
      botToken: "tc",
      botUsername: "c_bot",
      transport: "webhook",
      webhookSecret: "s",
    });
    const listed = listEnabledPollConfigs(db, Date.now());
    expect(listed.length).toBe(1);
    expect(listed[0]!.project).toBe("alpha");
  });

  test("claim is one-shot until the lease elapses", () => {
    upsertTelegramConfig(db, {
      project: "alpha",
      botToken: "t",
      botUsername: "a_bot",
    });
    const now = Date.now();
    expect(claimPollLease(db, "alpha", now, 10_000)).toBe(true);
    expect(claimPollLease(db, "alpha", now + 5_000, 10_000)).toBe(false);
    expect(claimPollLease(db, "alpha", now + 11_000, 10_000)).toBe(true);
  });

  test("releasePollLease makes the row immediately claimable again", () => {
    upsertTelegramConfig(db, {
      project: "alpha",
      botToken: "t",
      botUsername: "a_bot",
    });
    const now = Date.now();
    expect(claimPollLease(db, "alpha", now, 60_000)).toBe(true);
    releasePollLease(db, "alpha");
    expect(claimPollLease(db, "alpha", now + 100, 60_000)).toBe(true);
  });
});

describe("advanceLastUpdateId", () => {
  test("advances monotonically", () => {
    upsertTelegramConfig(db, {
      project: "alpha",
      botToken: "t",
      botUsername: "a_bot",
    });
    advanceLastUpdateId(db, "alpha", 10);
    expect(getTelegramConfig(db, "alpha")!.lastUpdateId).toBe(10);
    advanceLastUpdateId(db, "alpha", 5); // stale — must not go backwards
    expect(getTelegramConfig(db, "alpha")!.lastUpdateId).toBe(10);
    advanceLastUpdateId(db, "alpha", 42);
    expect(getTelegramConfig(db, "alpha")!.lastUpdateId).toBe(42);
  });
});
