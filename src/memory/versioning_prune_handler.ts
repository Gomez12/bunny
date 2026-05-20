/**
 * Scheduler handler: trim the universal `entity_versions` chain to the
 * configured cap. See `pruneEntityVersions` for the keep rules.
 *
 * Runs once a day by default — versioning storage grows slowly compared to
 * messages/events tables and the keep policy preserves every lifecycle marker
 * so we never lose audit signal, only intermediate `save` rows beyond the
 * recent window.
 */

import type {
  HandlerRegistry,
  TaskHandlerContext,
} from "../scheduler/handlers.ts";
import { pruneEntityVersions } from "./versioning.ts";

export const VERSIONING_PRUNE_HANDLER = "versioning.prune";

export async function versioningPruneHandler(
  ctx: TaskHandlerContext,
): Promise<void> {
  const { db, queue } = ctx;
  const result = pruneEntityVersions(db);
  if (result.deleted === 0) return;
  void queue.log({
    topic: "versioning",
    kind: "prune",
    data: { deleted: result.deleted, entities: result.entities },
  });
}

export function registerVersioningPrune(registry: HandlerRegistry): void {
  registry.register(VERSIONING_PRUNE_HANDLER, versioningPruneHandler);
}
