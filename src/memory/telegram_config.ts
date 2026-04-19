/**
 * Per-project Telegram bot configuration.
 *
 * One row per project. The bot token is per-project so admins can give each
 * project its own @bot — isolation is natural, and the `chat_id` space is
 * inherently per-token (you can't accidentally leak a chat across projects).
 *
 * Two transport modes:
 *   - `poll`    — scheduler ticks call `getUpdates`; default, works without a
 *                 public URL.
 *   - `webhook` — Telegram POSTs updates to us; requires a publicly reachable
 *                 HTTPS endpoint. The `webhook_secret` lives here and is
 *                 compared constant-time against the header Telegram sends.
 *
 * `poll_lease_until` is used for ticker race-safety — see
 * `claimPollLease` / `releasePollLease` below. Claim is a conditional UPDATE
 * so concurrent ticks cannot double-process a project.
 *
 * See ADR 0028.
 */

import type { Database } from "bun:sqlite";

export type TelegramTransport = "poll" | "webhook";

export interface TelegramConfig {
  project: string;
  botToken: string;
  botUsername: string;
  transport: TelegramTransport;
  webhookSecret: string | null;
  lastUpdateId: number;
  enabled: boolean;
  pollLeaseUntil: number;
  createdAt: number;
  updatedAt: number;
}

interface ConfigRow {
  project: string;
  bot_token: string;
  bot_username: string;
  transport: string;
  webhook_secret: string | null;
  last_update_id: number;
  enabled: number;
  poll_lease_until: number;
  created_at: number;
  updated_at: number;
}

const COLS = `project, bot_token, bot_username, transport, webhook_secret,
              last_update_id, enabled, poll_lease_until,
              created_at, updated_at`;

function rowToConfig(r: ConfigRow): TelegramConfig {
  return {
    project: r.project,
    botToken: r.bot_token,
    botUsername: r.bot_username,
    transport: r.transport === "webhook" ? "webhook" : "poll",
    webhookSecret: r.webhook_secret,
    lastUpdateId: r.last_update_id,
    enabled: r.enabled !== 0,
    pollLeaseUntil: r.poll_lease_until,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function getTelegramConfig(
  db: Database,
  project: string,
): TelegramConfig | null {
  const row = db
    .prepare(`SELECT ${COLS} FROM project_telegram_config WHERE project = ?`)
    .get(project) as ConfigRow | undefined;
  return row ? rowToConfig(row) : null;
}

export function listEnabledPollConfigs(
  db: Database,
  now: number,
): TelegramConfig[] {
  const rows = db
    .prepare(
      `SELECT ${COLS} FROM project_telegram_config
        WHERE enabled = 1 AND transport = 'poll' AND poll_lease_until <= ?
        ORDER BY project ASC`,
    )
    .all(now) as ConfigRow[];
  return rows.map(rowToConfig);
}

export function listAllConfigs(db: Database): TelegramConfig[] {
  const rows = db
    .prepare(`SELECT ${COLS} FROM project_telegram_config ORDER BY project ASC`)
    .all() as ConfigRow[];
  return rows.map(rowToConfig);
}

export interface UpsertConfigOpts {
  project: string;
  botToken: string;
  botUsername: string;
  transport?: TelegramTransport;
  webhookSecret?: string | null;
  enabled?: boolean;
}

/** Insert or update; never returns the row to a client — callers re-read. */
export function upsertTelegramConfig(
  db: Database,
  opts: UpsertConfigOpts,
): TelegramConfig {
  const now = Date.now();
  const existing = getTelegramConfig(db, opts.project);
  if (existing) {
    db.prepare(
      `UPDATE project_telegram_config
         SET bot_token = ?, bot_username = ?, transport = ?,
             webhook_secret = ?, enabled = ?, updated_at = ?
       WHERE project = ?`,
    ).run(
      opts.botToken,
      opts.botUsername,
      opts.transport ?? existing.transport,
      opts.webhookSecret === undefined
        ? existing.webhookSecret
        : opts.webhookSecret,
      opts.enabled === undefined
        ? existing.enabled
          ? 1
          : 0
        : opts.enabled
          ? 1
          : 0,
      now,
      opts.project,
    );
  } else {
    db.prepare(
      `INSERT INTO project_telegram_config(
         project, bot_token, bot_username, transport, webhook_secret,
         last_update_id, enabled, poll_lease_until, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 0, ?, 0, ?, ?)`,
    ).run(
      opts.project,
      opts.botToken,
      opts.botUsername,
      opts.transport ?? "poll",
      opts.webhookSecret ?? null,
      opts.enabled === false ? 0 : 1,
      now,
      now,
    );
  }
  return getTelegramConfig(db, opts.project)!;
}

export interface PatchConfigOpts {
  botToken?: string;
  botUsername?: string;
  transport?: TelegramTransport;
  webhookSecret?: string | null;
  enabled?: boolean;
}

export function patchTelegramConfig(
  db: Database,
  project: string,
  patch: PatchConfigOpts,
): TelegramConfig {
  const existing = getTelegramConfig(db, project);
  if (!existing)
    throw new Error(`telegram config for project '${project}' not found`);
  const now = Date.now();
  db.prepare(
    `UPDATE project_telegram_config
       SET bot_token = ?, bot_username = ?, transport = ?,
           webhook_secret = ?, enabled = ?, updated_at = ?
     WHERE project = ?`,
  ).run(
    patch.botToken ?? existing.botToken,
    patch.botUsername ?? existing.botUsername,
    patch.transport ?? existing.transport,
    patch.webhookSecret === undefined
      ? existing.webhookSecret
      : patch.webhookSecret,
    patch.enabled === undefined
      ? existing.enabled
        ? 1
        : 0
      : patch.enabled
        ? 1
        : 0,
    now,
    project,
  );
  return getTelegramConfig(db, project)!;
}

export function deleteTelegramConfig(db: Database, project: string): void {
  db.prepare(`DELETE FROM project_telegram_config WHERE project = ?`).run(
    project,
  );
}

export function advanceLastUpdateId(
  db: Database,
  project: string,
  updateId: number,
): void {
  // Only write when the id actually moved forward. Skipping the no-op write
  // saves a row touch on every re-delivered update and on out-of-order
  // dispatches.
  db.prepare(
    `UPDATE project_telegram_config
       SET last_update_id = ?, updated_at = ?
     WHERE project = ? AND last_update_id < ?`,
  ).run(updateId, Date.now(), project, updateId);
}

/**
 * Conditionally claim a polling lease. Returns true when the caller won the
 * race. The lease is short (50 s by default) so a stuck / crashed tick
 * self-heals within one cron interval.
 */
export function claimPollLease(
  db: Database,
  project: string,
  now: number,
  leaseMs = 50_000,
): boolean {
  const info = db
    .prepare(
      `UPDATE project_telegram_config
         SET poll_lease_until = ?, updated_at = ?
       WHERE project = ? AND poll_lease_until <= ?`,
    )
    .run(now + leaseMs, now, project, now);
  return info.changes > 0;
}

export function releasePollLease(db: Database, project: string): void {
  db.prepare(
    `UPDATE project_telegram_config SET poll_lease_until = 0, updated_at = ?
     WHERE project = ?`,
  ).run(Date.now(), project);
}
