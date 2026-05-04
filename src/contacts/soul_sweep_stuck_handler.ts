/**
 * Scheduler handler: reclaim contact rows stuck in `soul_status='refreshing'`.
 *
 * The per-row flip happens just before the LLM call. If the process dies
 * mid-call (SIGKILL, OOM, restart), the row never returns to `'idle'` — and
 * `contact.soul_refresh` only picks up `idle` rows, so it never retries on
 * its own.
 *
 * Mirrors `src/kb/sweep_stuck_handler.ts`. Threshold defaults to 30 min via
 * `cfg.contacts.soulStuckThresholdMs`.
 */

import type {
  HandlerRegistry,
  TaskHandlerContext,
} from "../scheduler/handlers.ts";
import { releaseStuckContactSouls } from "../memory/contacts.ts";

export const CONTACT_SOUL_SWEEP_HANDLER = "contact.soul_sweep_stuck";

export async function contactSoulSweepHandler(
  ctx: TaskHandlerContext,
): Promise<void> {
  const { db, queue, cfg, now } = ctx;
  const reset = releaseStuckContactSouls(
    db,
    cfg.contacts.soulStuckThresholdMs,
    now,
  );
  if (reset.length === 0) return;
  void queue.log({
    topic: "contact",
    kind: "soul.sweep.stuck",
    data: { reset },
  });
}

export function registerContactSoulSweep(registry: HandlerRegistry): void {
  registry.register(CONTACT_SOUL_SWEEP_HANDLER, contactSoulSweepHandler);
}
