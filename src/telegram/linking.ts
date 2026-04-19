/**
 * Telegram chat ↔ Bunny user linking.
 *
 * Linking flow (per ADR 0028):
 *   1. User opens Settings → "Telegram links" → picks a project.
 *   2. `startPendingLink` writes a 15-min TTL row in `telegram_pending_links`
 *      and returns the token + `https://t.me/<bot>?start=<token>` URL.
 *   3. User taps the link → Telegram sends `/start <token>`.
 *   4. The bot's handler invokes `consumePendingLink`, which — atomically —
 *      validates the token, writes a `user_telegram_links` row, and deletes
 *      the pending row.
 *
 * Errors are returned as tagged results so the caller can render the exact
 * reason for the user (expired, wrong project, already linked elsewhere, …).
 */

import type { Database } from "bun:sqlite";
import {
  createPendingLink,
  deletePendingLink,
  getPendingLink,
  sweepExpiredPendingLinks,
  type PendingLink,
} from "../memory/telegram_pending.ts";
import { getTelegramConfig } from "../memory/telegram_config.ts";
import { upsertLink, type TelegramLink } from "../memory/telegram_links.ts";

export interface StartPendingLinkOpts {
  userId: string;
  project: string;
  ttlMs?: number;
}

export interface StartPendingLinkResult {
  token: string;
  expiresAt: number;
  botUsername: string;
  deepLink: string;
}

export function startPendingLink(
  db: Database,
  opts: StartPendingLinkOpts,
): StartPendingLinkResult {
  const cfg = getTelegramConfig(db, opts.project);
  if (!cfg)
    throw new Error(`Telegram is not configured for project '${opts.project}'`);
  if (!cfg.enabled)
    throw new Error(`Telegram is disabled for project '${opts.project}'`);
  const pending = createPendingLink(db, {
    userId: opts.userId,
    project: opts.project,
    ttlMs: opts.ttlMs,
  });
  return {
    token: pending.linkToken,
    expiresAt: pending.expiresAt,
    botUsername: cfg.botUsername,
    deepLink: `https://t.me/${cfg.botUsername}?start=${pending.linkToken}`,
  };
}

export type ConsumeLinkOutcome =
  | { kind: "linked"; link: TelegramLink; pending: PendingLink }
  | { kind: "expired_or_invalid" }
  | { kind: "wrong_project"; expected: string; got: string };

export interface ConsumePendingLinkOpts {
  project: string;
  chatId: number;
  token: string;
  tgUsername?: string | null;
  now?: number;
}

/**
 * Consume a pending token. Returns a tagged union so the inbound handler can
 * render the exact failure cause back to the user's Telegram chat.
 *
 * Correctness: wrapped in a transaction so a concurrent consume of the same
 * token can't double-issue a link. The pending row is deleted INSIDE the tx.
 */
export function consumePendingLink(
  db: Database,
  opts: ConsumePendingLinkOpts,
): ConsumeLinkOutcome {
  const now = opts.now ?? Date.now();
  // Opportunistic sweep so the table stays tiny.
  sweepExpiredPendingLinks(db, now);

  const tx = db.transaction((): ConsumeLinkOutcome => {
    const pending = getPendingLink(db, opts.token, now);
    if (!pending) return { kind: "expired_or_invalid" };
    if (pending.project !== opts.project) {
      // Link was generated for a different project than the bot that received
      // the /start. Surface the mismatch so the user can fix it (or we can
      // just pipe them to the right project).
      deletePendingLink(db, opts.token);
      return {
        kind: "wrong_project",
        expected: pending.project,
        got: opts.project,
      };
    }
    const link = upsertLink(db, {
      userId: pending.userId,
      project: opts.project,
      chatId: opts.chatId,
      tgUsername: opts.tgUsername,
    });
    deletePendingLink(db, opts.token);
    return { kind: "linked", link, pending };
  });
  return tx();
}
