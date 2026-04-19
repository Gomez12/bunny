/**
 * Outbound Telegram delivery for user-targeted events.
 *
 * Every caller that wants to push something to a user's Telegram goes through
 * `sendTelegramToUser`. It:
 *   1. Resolves the per-project link for `userId`. No link → silent no-op.
 *   2. Loads the per-project bot config. Disabled / absent → silent no-op.
 *   3. Formats the text (markdown → HTML subset, chunk if long, document
 *      fallback over 16 KB).
 *   4. Sends with rate-limit and Bot API error handling baked in.
 *
 * Everything is logged via the queue (`topic: "telegram"`). The caller
 * decides when to skip — e.g. self-pings (`recipientUserId === actorUserId`)
 * are *not* suppressed here; the hook layer is responsible.
 */

import type { Database } from "bun:sqlite";
import type { BunnyQueue } from "../queue/bunqueue.ts";
import type { TelegramConfig as TelegramRuntimeConfig } from "../config.ts";
import { errorMessage } from "../util/error.ts";
import { getTelegramConfig } from "../memory/telegram_config.ts";
import { getLinkByUser } from "../memory/telegram_links.ts";
import { sendMessage, sendDocument, TelegramApiError } from "./client.ts";
import { decideFormat } from "./format.ts";
import { tokenTail } from "./util.ts";

export interface SendTelegramOpts {
  userId: string;
  project: string;
  text: string;
  /** Telegram's `disable_notification` for quiet pings (card-run digest, etc.). */
  silent?: boolean;
  /** Short label used for queue logging (`mention`, `card_run`, `news_digest`). */
  source?: string;
}

/**
 * Deliver a message to a user's Telegram for `project`. Returns silently when
 * the user has no link or the bot is disabled — outbound is a best-effort
 * channel, not a promise.
 */
export async function sendTelegramToUser(
  db: Database,
  queue: BunnyQueue,
  tgRuntimeCfg: TelegramRuntimeConfig,
  opts: SendTelegramOpts,
): Promise<void> {
  const link = getLinkByUser(db, opts.userId, opts.project);
  if (!link) return;
  const tgCfg = getTelegramConfig(db, opts.project);
  if (!tgCfg || !tgCfg.enabled) return;

  const decision = decideFormat(opts.text, {
    documentFallbackSize: tgRuntimeCfg.documentFallbackBytes,
    maxChunkChars: tgRuntimeCfg.chunkChars,
  });

  try {
    if (decision.mode === "document") {
      await sendDocument(tgCfg.botToken, {
        chat_id: link.chatId,
        filename: decision.filename ?? "bunny-reply.md",
        content: decision.chunks[0] ?? "",
      });
    } else {
      for (const chunk of decision.chunks) {
        await sendMessage(tgCfg.botToken, {
          chat_id: link.chatId,
          text: chunk,
          parse_mode: "HTML",
          disable_web_page_preview: true,
          disable_notification: opts.silent ?? false,
        });
      }
    }
    void queue.log({
      topic: "telegram",
      kind: "message.outbound",
      userId: opts.userId,
      data: {
        project: opts.project,
        chatId: link.chatId,
        source: opts.source ?? "unknown",
        mode: decision.mode,
        chunks: decision.chunks.length,
        tokenTail: tokenTail(tgCfg.botToken),
      },
    });
  } catch (err) {
    const tgErr =
      err instanceof TelegramApiError
        ? {
            code: err.code,
            description: err.description,
            retryAfter: err.retryAfter,
          }
        : undefined;
    void queue.log({
      topic: "telegram",
      kind: "error",
      userId: opts.userId,
      data: {
        stage: "outbound",
        project: opts.project,
        chatId: link.chatId,
        source: opts.source ?? "unknown",
        tgErr,
      },
      error: errorMessage(err),
    });
  }
}
