/**
 * Scheduler handler: reclaim business rows stuck in `soul_status='refreshing'`.
 * Mirror of `src/contacts/soul_sweep_stuck_handler.ts`.
 */

import type {
  HandlerRegistry,
  TaskHandlerContext,
} from "../scheduler/handlers.ts";
import { releaseStuckBusinessSouls } from "../memory/businesses.ts";

export const BUSINESS_SOUL_SWEEP_HANDLER = "business.soul_sweep_stuck";

export async function businessSoulSweepHandler(
  ctx: TaskHandlerContext,
): Promise<void> {
  const { db, queue, cfg, now } = ctx;
  const reset = releaseStuckBusinessSouls(
    db,
    cfg.businesses.soulStuckThresholdMs,
    now,
  );
  if (reset.length === 0) return;
  void queue.log({
    topic: "business",
    kind: "soul.sweep.stuck",
    data: { reset },
  });
}

export function registerBusinessSoulSweep(registry: HandlerRegistry): void {
  registry.register(BUSINESS_SOUL_SWEEP_HANDLER, businessSoulSweepHandler);
}
