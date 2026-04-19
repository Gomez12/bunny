/**
 * Webhook lifecycle coupling.
 *
 * Changing transport (poll ↔ webhook) must be reflected on Telegram's side:
 *   - transport = 'webhook'  → call `setWebhook(url, secret)`
 *   - transport = 'poll'     → call `deleteWebhook()`
 * With a webhook set, `getUpdates` returns 409 — flips have to happen on both
 * sides together.
 *
 * `applyTransport` is called from the config PUT handler AND at boot (via
 * `reapplyAllTransports`) so a restart doesn't leave a webhook dangling after
 * the config flipped while the server was down.
 *
 * Webhook URL format: `<publicBaseUrl>/api/telegram/webhook/<project>`. The
 * admin enters a public URL once on the config form; we persist it? No — v1
 * keeps it per-request because self-hosted installs often run behind a tunnel
 * that changes addresses. The config form carries the current public URL and
 * re-applies on save.
 */

import type { Database } from "bun:sqlite";
import type { BunnyQueue } from "../queue/bunqueue.ts";
import { errorMessage } from "../util/error.ts";
import { deleteWebhook, setWebhook, TelegramApiError } from "./client.ts";
import {
  getTelegramConfig,
  listAllConfigs,
  type TelegramConfig,
} from "../memory/telegram_config.ts";

export interface ApplyTransportOpts {
  db: Database;
  queue: BunnyQueue;
  project: string;
  /** Base URL that Telegram should POST updates to. Required when
   *  transport='webhook'; ignored otherwise. */
  publicBaseUrl?: string;
}

function buildWebhookUrl(baseUrl: string, project: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return `${trimmed}/api/telegram/webhook/${encodeURIComponent(project)}`;
}

export async function applyTransport(opts: ApplyTransportOpts): Promise<void> {
  const cfg = getTelegramConfig(opts.db, opts.project);
  if (!cfg) return;
  try {
    if (cfg.transport === "webhook") {
      if (!opts.publicBaseUrl) {
        throw new Error("publicBaseUrl is required when transport='webhook'");
      }
      if (!cfg.webhookSecret) {
        throw new Error("webhook_secret must be set before enabling webhook");
      }
      const url = buildWebhookUrl(opts.publicBaseUrl, opts.project);
      await setWebhook(cfg.botToken, {
        url,
        secret_token: cfg.webhookSecret,
        drop_pending_updates: false,
      });
      void opts.queue.log({
        topic: "telegram",
        kind: "webhook.register",
        data: { project: opts.project, url },
      });
    } else {
      await deleteWebhook(cfg.botToken);
      void opts.queue.log({
        topic: "telegram",
        kind: "webhook.delete",
        data: { project: opts.project },
      });
    }
  } catch (err) {
    const tgErr =
      err instanceof TelegramApiError
        ? {
            code: err.code,
            description: err.description,
            retryAfter: err.retryAfter,
          }
        : undefined;
    void opts.queue.log({
      topic: "telegram",
      kind: "error",
      data: { stage: "apply_transport", project: opts.project, tgErr },
      error: errorMessage(err),
    });
    throw err;
  }
}

/**
 * Self-heal every project's transport on boot. Webhook projects re-register,
 * poll projects delete any stale webhook Telegram still has.
 *
 * Called from `startServer` — errors are logged but never rethrown.
 */
export async function reapplyAllTransports(
  db: Database,
  queue: BunnyQueue,
  publicBaseUrl: string | undefined,
): Promise<void> {
  const all = listAllConfigs(db);
  for (const cfg of all) {
    if (!cfg.enabled) continue;
    if (cfg.transport === "webhook" && !publicBaseUrl) {
      // Can't re-register without a URL; skip silently and let the admin
      // re-save from the UI once the public URL is known.
      void queue.log({
        topic: "telegram",
        kind: "webhook.register.skipped",
        data: { project: cfg.project, reason: "no_public_base_url" },
      });
      continue;
    }
    try {
      await applyTransport({
        db,
        queue,
        project: cfg.project,
        publicBaseUrl,
      });
    } catch {
      /* already logged in applyTransport */
    }
  }
}

export type { TelegramConfig };
