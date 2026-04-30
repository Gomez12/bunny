/**
 * Scheduler handler: reclaim KB definitions stuck in `llm_status='generating'`
 * or `svg_status='generating'`.
 *
 * The per-row flip to `'generating'` happens just before the LLM call. If the
 * process dies mid-call (SIGKILL, OOM, restart), the row never returns to
 * `'idle'` — and `kb.auto_generate_scan` only picks up `idle` rows, so it
 * never retries on its own.
 *
 * This handler runs every 5 minutes and flips rows whose `updated_at` is older
 * than `STUCK_THRESHOLD_MS` back to `'idle'`. The auto-generate handler then
 * re-runs them on its next tick. Mirrors `src/translation/sweep_stuck_handler.ts`.
 */

import type {
  HandlerRegistry,
  TaskHandlerContext,
} from "../scheduler/handlers.ts";
import { resetStuckGenerating } from "../memory/kb_definitions.ts";

export const KB_SWEEP_STUCK_HANDLER = "kb.sweep_stuck";

const STUCK_THRESHOLD_MS = 30 * 60 * 1000;

export async function kbSweepStuckHandler(
  ctx: TaskHandlerContext,
): Promise<void> {
  const { db, queue, now } = ctx;
  const { llmReset, svgReset } = resetStuckGenerating(
    db,
    STUCK_THRESHOLD_MS,
    now,
  );
  if (llmReset.length === 0 && svgReset.length === 0) return;

  void queue.log({
    topic: "kb",
    kind: "sweep.stuck",
    data: { llmReset, svgReset },
  });
}

export function registerKbSweepStuck(registry: HandlerRegistry): void {
  registry.register(KB_SWEEP_STUCK_HANDLER, kbSweepStuckHandler);
}
