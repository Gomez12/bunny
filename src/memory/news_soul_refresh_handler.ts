/**
 * Scheduler handler `memory.news_soul.refresh`
 *
 * Periodically distills a user's news reactions into a stable interests
 * profile (`users.news_soul`). The main user soul reads this as a reference
 * so individual liked/disliked items don't cause large swings in the general
 * soul — they accumulate here first.
 *
 * Runs every 6 h. Only processes users who have received ≥ 3 new reactions
 * since their last news-soul refresh.
 */

import type { Database } from "bun:sqlite";
import type {
  HandlerRegistry,
  TaskHandlerContext,
} from "../scheduler/handlers.ts";
import { chatSync } from "../llm/adapter.ts";
import { errorDetails } from "../util/error.ts";
import { getReactionsSummary } from "./news_reactions.ts";
import {
  claimUserNewsSoulForRefresh,
  getUserNewsSoul,
  listUsersDueForNewsSoulRefresh,
  releaseStuckNewsSouls,
  setUserNewsSoulAuto,
  setUserNewsSoulError,
} from "./news_soul.ts";

export const NEWS_SOUL_REFRESH_HANDLER = "memory.news_soul.refresh";

const MAX_SOUL_CHARS = 1_200;
const MAX_CONCURRENT = 3;

function buildPrompt(
  currentSoul: string,
  reactions: ReturnType<typeof getReactionsSummary>,
): string {
  const reactionLines = reactions
    .map((r) => {
      const label = r.reaction === "up" ? "👍" : "👎";
      const src = [r.topicName, r.source].filter(Boolean).join(" · ");
      return `${label} "${r.title}"${src ? ` [${src}]` : ""}`;
    })
    .join("\n");

  return `You maintain a user's news interest profile based on their reactions to news items.

Current profile:
${currentSoul || "(empty)"}

New reactions:
${reactionLines}

Update the profile. Rules:
- Summarise interests as categories/topics, NOT individual article titles
- List topics they like and topics they dislike
- Note patterns (prefers depth over tutorials, interested in open-source, etc.)
- Keep it stable: a single dislike doesn't erase an interest category
- Max ${MAX_SOUL_CHARS} characters
- Plain text, no markdown

Return only the updated profile text.`;
}

async function refreshOneUser(
  db: Database,
  ctx: TaskHandlerContext,
  userId: string,
): Promise<void> {
  if (!claimUserNewsSoulForRefresh(db, userId)) return; // lost race

  try {
    const current = getUserNewsSoul(db, userId);
    const reactions = getReactionsSummary(db, userId, 50);
    if (reactions.length === 0) {
      setUserNewsSoulAuto(db, userId, current?.soul ?? "");
      return;
    }

    const response = await chatSync(ctx.cfg.llm, {
      model: ctx.cfg.llm.model,
      messages: [
        { role: "user", content: buildPrompt(current?.soul ?? "", reactions) },
      ],
    });

    const updated = (response.message.content ?? "")
      .trim()
      .slice(0, MAX_SOUL_CHARS);
    setUserNewsSoulAuto(db, userId, updated);

    void ctx.queue.log({
      topic: "memory",
      kind: "news_soul.refresh.done",
      userId,
      data: { reactions: reactions.length, chars: updated.length },
    });
  } catch (e) {
    const msg = errorDetails(e);
    setUserNewsSoulError(db, userId, msg);
    void ctx.queue.log({
      topic: "memory",
      kind: "news_soul.refresh.error",
      userId,
      error: msg,
    });
  }
}

async function newsSoulRefreshHandler(ctx: TaskHandlerContext): Promise<void> {
  const db = ctx.db;

  // Reclaim any rows stuck from a previous crashed tick
  releaseStuckNewsSouls(db);

  const due = listUsersDueForNewsSoulRefresh(db);
  if (due.length === 0) return;

  // Process in batches of MAX_CONCURRENT
  for (let i = 0; i < due.length; i += MAX_CONCURRENT) {
    const batch = due.slice(i, i + MAX_CONCURRENT);
    await Promise.all(batch.map((u) => refreshOneUser(db, ctx, u.userId)));
  }
}

export function registerNewsSoulRefresh(registry: HandlerRegistry): void {
  registry.register(NEWS_SOUL_REFRESH_HANDLER, newsSoulRefreshHandler);
}
