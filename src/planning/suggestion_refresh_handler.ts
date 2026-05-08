/**
 * Scheduler handler: refresh the pending suggestion for stale planning
 * projects. Stale = no current pending row, or any wish/team/deadline has
 * been edited after the previous suggestion was generated. Capped per tick
 * by `cfg.planning.suggestionRefreshBatchSize`.
 *
 * The handler never touches user-approved data (planned_*_date columns).
 * It only writes to `planning_suggestions`. The user is the only path
 * that copies suggestion → wishes (see /suggestion/apply).
 */

import type { Database } from "bun:sqlite";
import type {
  HandlerRegistry,
  TaskHandlerContext,
} from "../scheduler/handlers.ts";
import { errorMessage } from "../util/error.ts";
import { selectStalePlanningProjectIds, replacePending } from "../memory/planning_suggestions.ts";
import { listWishes } from "../memory/planning_wishes.ts";
import { listTeams } from "../memory/planning_teams.ts";
import { listDeadlines } from "../memory/planning_deadlines.ts";
import { listTags } from "../memory/planning_tags.ts";
import { getPlanningProject } from "../memory/planning_projects.ts";
import { computeSchedule, formatDate } from "./scheduler.ts";

export const PLANNING_SUGGESTION_REFRESH_HANDLER = "planning.suggestion_refresh";

export function buildAndStoreSuggestion(
  db: Database,
  planningProjectId: number,
  generatedByUserId: string | null,
): { placements: number; bottlenecks: number } | null {
  const pp = getPlanningProject(db, planningProjectId);
  if (!pp) return null;
  const wishes = listWishes(db, planningProjectId);
  const teams = listTeams(db, planningProjectId);
  const deadlines = listDeadlines(db, planningProjectId);
  const tags = listTags(db, planningProjectId);
  const startDate = pp.startDate ?? formatDate(new Date());
  const out = computeSchedule({
    startDate,
    wishes: wishes.map((w) => ({
      id: w.id,
      durationDays: w.durationDays,
      teamId: w.teamId,
      deadlineId: w.deadlineId,
      dependsOnWishes: w.dependsOnWishes,
      dependsOnTags: w.dependsOnTags,
      tagIds: w.tagIds,
    })),
    teams: teams.map((t) => ({ id: t.id, maxParallel: t.maxParallel })),
    deadlines: deadlines.map((d) => ({ id: d.id, dueDate: d.dueDate })),
    tags: tags.map((t) => ({ id: t.id, name: t.name })),
  });
  replacePending(
    db,
    planningProjectId,
    {
      placements: out.placements.map((p) => ({
        wishId: p.wishId,
        start: p.start,
        end: p.end,
      })),
      bottlenecks: out.bottlenecks.map((b) => ({
        wishId: b.wishId,
        kind: b.kind,
        message: b.message,
      })),
    },
    generatedByUserId,
  );
  return { placements: out.placements.length, bottlenecks: out.bottlenecks.length };
}

export async function planningSuggestionRefreshHandler(
  ctx: TaskHandlerContext,
): Promise<void> {
  const { db, queue, cfg } = ctx;
  const limit = cfg.planning?.suggestionRefreshBatchSize ?? 5;
  const ids = selectStalePlanningProjectIds(db, limit);
  if (ids.length === 0) return;
  for (const id of ids) {
    try {
      const summary = buildAndStoreSuggestion(db, id, null);
      void queue.log({
        topic: "planning",
        kind: "suggestion.refresh",
        data: { planningProjectId: id, ...(summary ?? {}) },
      });
    } catch (e) {
      void queue.log({
        topic: "planning",
        kind: "suggestion.refresh.error",
        data: { planningProjectId: id },
        error: errorMessage(e),
      });
    }
  }
}

export function registerPlanningSuggestionRefresh(
  registry: HandlerRegistry,
): void {
  registry.register(
    PLANNING_SUGGESTION_REFRESH_HANDLER,
    planningSuggestionRefreshHandler,
  );
}
