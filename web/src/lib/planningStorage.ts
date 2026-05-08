/**
 * Centralised localStorage keys for the Planning module. Avoids stringly-typed
 * call sites scattered across views and ensures everyone agrees on the spelling.
 *
 * Per-Bunny-project keys are functions because their final form depends on
 * the active project name. Static keys are plain string constants.
 */

export const PLANNING_STORAGE = {
  /** Active planning project, per Bunny project (`bunny.activePlanningProject.<bunnyProject>`). */
  activeProject: (bunnyProject: string) =>
    `bunny.activePlanningProject.${bunnyProject}`,
  /** Active feature in the secondary rail (Roadmap / Wishes / …). Global. */
  activeFeature: "bunny.activePlanningFeature",
  /** Confirm-before-applying-drag toggle on the Roadmap. */
  confirmDrag: "bunny.planningConfirmDrag",
  /** Roadmap zoom level (`week` / `month` / `quarter`). */
  roadmapZoom: "bunny.planningRoadmapZoom",
  /** Suggestion-panel mode (`all` / `conflicts_only`). */
  suggestionMode: "bunny.planningSuggestionMode",
  /** Suggestion-panel "Show hidden" toggle. */
  suggestionShowHidden: "bunny.planningSuggestionShowHidden",
} as const;

/** Move ISO-8601 week computation here so view code stays terse. */
export function isoWeek(d: Date): string {
  const dt = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
  const dayNum = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(
    ((dt.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7,
  );
  return `${dt.getUTCFullYear()}-W${weekNo.toString().padStart(2, "0")}`;
}
