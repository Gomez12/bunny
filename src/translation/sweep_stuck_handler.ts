/**
 * Scheduler handler: reclaim sidecar rows stuck in `translating`.
 *
 * Per-row claims flip to `translating` + stamp `translating_at`. If the
 * process dies mid-call (SIGKILL, OOM), the row stays `translating` forever
 * — a subsequent tick's `claimPending` only picks up `pending` rows, so
 * nothing else will touch it. The user's manual "Translate now" button can
 * re-trigger, but that's friction.
 *
 * This handler runs once a day (cron `0 3 * * *`) and flips any
 * `status='translating' AND translating_at < now - threshold` row back to
 * `pending`. The 24-hour window is acceptable because stuck rows only happen
 * on process death mid-translation, which is rare — and keeping the recovery
 * as a separate scheduled task (vs. embedding it in the auto-translate tick)
 * keeps the per-tick handler lean and gives admins an obvious knob in the
 * Tasks tab. See ADR 0022.
 */

import type {
  HandlerRegistry,
  TaskHandlerContext,
} from "../scheduler/handlers.ts";
import { listKinds, sweepStuckTranslating } from "../memory/translatable.ts";

export const TRANSLATION_SWEEP_HANDLER = "translation.sweep_stuck";

export async function sweepStuckHandler(
  ctx: TaskHandlerContext,
): Promise<void> {
  const threshold = ctx.cfg.translation.stuckThresholdMs;
  const reclaimed: Record<string, number> = {};
  for (const kind of listKinds()) {
    const n = sweepStuckTranslating(ctx.db, kind, threshold, ctx.now);
    if (n > 0) reclaimed[kind.name] = n;
  }
  void ctx.queue.log({
    topic: "translation",
    kind: "sweep.stuck",
    data: { thresholdMs: threshold, reclaimed },
  });
}

export function registerSweepStuck(registry: HandlerRegistry): void {
  registry.register(TRANSLATION_SWEEP_HANDLER, sweepStuckHandler);
}
