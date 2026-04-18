/**
 * Scheduler handler: tick through every due `web_news_topics` row and spawn
 * `runTopic` detached. Mirrors `src/board/auto_run_handler.ts` in shape:
 * the registry + `ensureSystemTask` wiring lives in `src/server/index.ts`.
 */

import type {
  HandlerRegistry,
  TaskHandlerContext,
} from "../scheduler/handlers.ts";
import { isAgentLinkedToProject } from "../memory/agents.ts";
import { selectDueTopics } from "../memory/web_news.ts";
import { registry as toolRegistry } from "../tools/index.ts";
import { runTopic } from "./run_topic.ts";
import { errorMessage } from "../util/error.ts";
import { getTopic } from "../memory/web_news.ts";
import { getSystemUserId } from "../auth/seed.ts";

export const WEB_NEWS_AUTO_RUN_HANDLER = "web_news.auto_run_scan";

const MAX_CONCURRENT = 3;

export async function webNewsAutoRunHandler(
  ctx: TaskHandlerContext,
): Promise<void> {
  const { db, queue, cfg, now } = ctx;
  const due = selectDueTopics(db, now);
  if (due.length === 0) return;

  // Cap concurrent dispatches per tick — the handler only spawns work, but
  // each spawn chews LLM tokens, so don't fan out unboundedly.
  const batch = due.slice(0, MAX_CONCURRENT);

  for (const cand of batch) {
    const topic = getTopic(db, cand.id);
    if (!topic) continue;
    if (!isAgentLinkedToProject(db, topic.project, topic.agent)) {
      void queue.log({
        topic: "scheduler",
        kind: "skip",
        data: {
          topicId: cand.id,
          reason: "agent-unlinked",
          project: topic.project,
          agent: topic.agent,
        },
      });
      continue;
    }
    // Fall back to the seeded `system` user when the creator has been
    // deleted. Never pass a non-user string — `setSessionHiddenFromChat`
    // has a FK on users(id).
    const triggeredBy = topic.createdBy ?? getSystemUserId(db);
    try {
      await runTopic({
        db,
        queue,
        cfg,
        tools: toolRegistry,
        topicId: cand.id,
        triggeredBy,
        triggerKind: "scheduled",
        now,
      });
    } catch (e) {
      void queue.log({
        topic: "scheduler",
        kind: "error",
        data: { topicId: cand.id, handler: WEB_NEWS_AUTO_RUN_HANDLER },
        error: errorMessage(e),
      });
    }
  }
}

export function registerWebNewsAutoRun(registry: HandlerRegistry): void {
  registry.register(WEB_NEWS_AUTO_RUN_HANDLER, webNewsAutoRunHandler);
}
