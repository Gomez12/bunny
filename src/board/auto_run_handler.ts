/** Scheduler handler: spawn `runCard` for every auto-run-eligible card. */

import type { Database } from "bun:sqlite";
import { clearAutoRun } from "../memory/board_cards.ts";
import type { HandlerRegistry, TaskHandlerContext } from "../scheduler/handlers.ts";
import { runCard } from "./run_card.ts";
import { registry as toolRegistry } from "../tools/index.ts";
import { errorMessage } from "../util/error.ts";
import { isAgentLinkedToProject } from "../memory/agents.ts";

export const BOARD_AUTO_RUN_HANDLER = "board.auto_run_scan";

interface Candidate {
  id: number;
  project: string;
  agent: string;
  createdBy: string;
}

function selectCandidates(db: Database): Candidate[] {
  return db
    .prepare(
      `SELECT c.id AS id, c.project AS project, c.assignee_agent AS agent,
              c.created_by AS createdBy
         FROM board_cards c
         JOIN board_swimlanes s ON s.id = c.swimlane_id
        WHERE c.archived_at IS NULL
          AND c.auto_run = 1
          AND c.assignee_agent IS NOT NULL
          AND s.auto_run = 1
          AND NOT EXISTS (
            SELECT 1 FROM board_card_runs r
             WHERE r.card_id = c.id
               AND r.status IN ('queued','running')
          )`,
    )
    .all() as Candidate[];
}

export async function boardAutoRunHandler(ctx: TaskHandlerContext): Promise<void> {
  const { db, queue, cfg } = ctx;
  const candidates = selectCandidates(db);
  if (candidates.length === 0) return;

  for (const cand of candidates) {
    if (!clearAutoRun(db, cand.id)) continue; // another tick won the race
    if (!isAgentLinkedToProject(db, cand.project, cand.agent)) {
      // Agent was unlinked after the flag was set — skip rather than fail.
      void queue.log({
        topic: "scheduler",
        kind: "skip",
        data: { cardId: cand.id, reason: "agent-unlinked", project: cand.project, agent: cand.agent },
      });
      continue;
    }
    try {
      await runCard({
        db,
        queue,
        cfg,
        tools: toolRegistry,
        cardId: cand.id,
        agent: cand.agent,
        triggeredBy: cand.createdBy,
        triggerKind: "scheduled",
      });
    } catch (e) {
      const msg = errorMessage(e);
      void queue.log({
        topic: "scheduler",
        kind: "error",
        data: { cardId: cand.id, handler: BOARD_AUTO_RUN_HANDLER },
        error: msg,
      });
      // Leave auto_run cleared: restoring risks tight retry loops.
    }
  }
}

export function registerBoardAutoRun(registry: HandlerRegistry): void {
  registry.register(BOARD_AUTO_RUN_HANDLER, boardAutoRunHandler);
}
