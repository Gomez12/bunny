/**
 * Scheduler handler `telegram.poll`.
 *
 * Runs every minute via `scheduled_tasks`. Each tick:
 *   1. Lists enabled projects with `transport = 'poll'` whose lease has
 *      lapsed.
 *   2. For each (up to MAX_CONCURRENT), claims a 50 s lease and calls
 *      `getUpdates?offset=last_update_id+1&timeout=0` (short-poll — simpler
 *      than long-poll, accepts up-to-60-s latency).
 *   3. Dispatches every update to `handleTelegramUpdate`. Poison safety is
 *      inside the handler: it advances `last_update_id` before processing.
 *   4. Releases the lease.
 *
 * We never swallow errors silently — everything flows to `queue.log` with
 * `topic: "telegram"` so the Logs tab can surface it.
 */

import type {
  HandlerRegistry,
  TaskHandlerContext,
} from "../scheduler/handlers.ts";
import {
  claimPollLease,
  listEnabledPollConfigs,
  releasePollLease,
} from "../memory/telegram_config.ts";
import { sweepSeenUpdates } from "../memory/telegram_seen.ts";
import { registry as toolsRegistry } from "../tools/index.ts";
import { getUpdates, TelegramApiError } from "./client.ts";
import { handleTelegramUpdate } from "./handle_update.ts";
import { errorMessage } from "../util/error.ts";
import { tokenTail } from "./util.ts";

export const TELEGRAM_POLL_HANDLER = "telegram.poll";

const MAX_CONCURRENT = 5;
const SEEN_SWEEP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export async function telegramPollHandler(
  ctx: TaskHandlerContext,
): Promise<void> {
  const { db, queue, cfg, now } = ctx;
  const due = listEnabledPollConfigs(db, now);
  if (due.length === 0) return;

  // Sweep stale dedup rows once per tick (cheap; prevents unbounded growth).
  sweepSeenUpdates(db, now - SEEN_SWEEP_MAX_AGE_MS);

  const batch = due.slice(0, MAX_CONCURRENT);

  await Promise.allSettled(
    batch.map(async (tgCfg) => {
      if (!claimPollLease(db, tgCfg.project, now, cfg.telegram.pollLeaseMs)) {
        // Another tick (or another process) got there first.
        return;
      }
      try {
        let updates;
        try {
          updates = await getUpdates(tgCfg.botToken, {
            offset: tgCfg.lastUpdateId + 1,
            timeout: 0,
            allowed_updates: ["message"],
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
            kind: "poll.error",
            data: {
              project: tgCfg.project,
              tokenTail: tokenTail(tgCfg.botToken),
              tgErr,
            },
            error: errorMessage(err),
          });
          return;
        }
        if (updates.length === 0) {
          void queue.log({
            topic: "telegram",
            kind: "poll.tick",
            data: { project: tgCfg.project, count: 0 },
          });
          return;
        }
        for (const update of updates) {
          try {
            await handleTelegramUpdate({
              db,
              queue,
              cfg,
              tools: toolsRegistry,
              project: tgCfg.project,
              update,
              now,
            });
          } catch (err) {
            void queue.log({
              topic: "telegram",
              kind: "error",
              data: {
                stage: "dispatch",
                project: tgCfg.project,
                updateId: update.update_id,
              },
              error: errorMessage(err),
            });
          }
        }
        void queue.log({
          topic: "telegram",
          kind: "poll.tick",
          data: { project: tgCfg.project, count: updates.length },
        });
      } finally {
        releasePollLease(db, tgCfg.project);
      }
    }),
  );
}

export function registerTelegramPoll(registry: HandlerRegistry): void {
  registry.register(TELEGRAM_POLL_HANDLER, telegramPollHandler);
}
