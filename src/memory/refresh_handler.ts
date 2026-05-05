/**
 * Scheduler handler `memory.refresh` — runs hourly and walks every active
 * (user, project) pair, every (agent, project) pair, and every user (for
 * soul). For each row whose newest message id is past the stored watermark
 * the handler asks an LLM to merge new facts into the existing body and
 * compact when over budget.
 *
 * Mirrors `src/kb/auto_generate_handler.ts` in shape: registry +
 * `ensureSystemTask` wiring lives in `src/server/index.ts`. Stuck rows
 * (process death mid-call) are reclaimed at the start of every tick.
 */

import type { Database } from "bun:sqlite";
import type {
  HandlerRegistry,
  TaskHandlerContext,
} from "../scheduler/handlers.ts";
import { runAgent } from "../agent/loop.ts";
import { silentRenderer } from "../agent/render.ts";
import { setSessionHiddenFromChat } from "./session_visibility.ts";
import { resolvePrompt, interpolate } from "../prompts/resolve.ts";
import { registry as toolRegistry } from "../tools/index.ts";
import { errorMessage } from "../util/error.ts";
import { SYSTEM_USERNAME } from "../auth/seed.ts";
import { getUserByUsername } from "../auth/users.ts";
import {
  getUserById,
  setUserSoulAuto,
  setUserSoulError,
  bumpUserSoulWatermark,
  claimUserSoulForRefresh,
  releaseStuckUserSoul,
} from "../auth/users.ts";
import { getAgent } from "./agents.ts";
import { MEMORY_FIELD_CHAR_LIMIT } from "./memory_constants.ts";
import {
  claimUserProjectMemoryForRefresh,
  ensureUserProjectMemory,
  getUserProjectMemory,
  releaseStuckUserProjectMemory,
  setUserProjectMemoryAuto,
  setUserProjectMemoryError,
  bumpUserProjectMemoryWatermark,
} from "./user_project_memory.ts";
import {
  claimAgentProjectMemoryForRefresh,
  ensureAgentProjectMemory,
  getAgentProjectMemory,
  releaseStuckAgentProjectMemory,
  setAgentProjectMemoryAuto,
  setAgentProjectMemoryError,
  bumpAgentProjectMemoryWatermark,
} from "./agent_project_memory.ts";
import {
  getUserMessagesAfter,
  getUserProjectMessagesAfter,
  getProjectAgentMessagesAfter,
  type MemoryRefreshMessage,
} from "./messages.ts";

export const MEMORY_REFRESH_HANDLER = "memory.refresh";

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_MAX_MESSAGES_PER_ROW = 200;
const DEFAULT_STUCK_THRESHOLD_MS = 30 * 60 * 1000;

interface ActiveUserProjectPair {
  userId: string;
  project: string;
  watermark: number;
  maxId: number;
}

/**
 * Active (user, project) pairs that have new content past their watermark and
 * are not currently locked by another tick. Ordered by gap-size descending so
 * the busiest rows get priority when the budget is tight.
 */
export function listActiveUserProjectPairs(
  db: Database,
  limit: number,
): ActiveUserProjectPair[] {
  // Empty string when the system user isn't seeded yet — the `user_id != ?`
  // predicate then matches every real row (no false-empty result).
  const systemUserId = getUserByUsername(db, SYSTEM_USERNAME)?.id ?? "";
  const rows = db
    .prepare(
      `WITH active AS (
         SELECT user_id, COALESCE(project, 'general') AS project,
                MAX(id) AS max_id
           FROM messages
          WHERE user_id IS NOT NULL
            AND user_id != ?
            AND channel = 'content'
            AND role IN ('user','assistant')
            AND content IS NOT NULL AND content != ''
            AND trimmed_at IS NULL
            AND from_automation = 0
          GROUP BY user_id, COALESCE(project, 'general')
       )
       SELECT a.user_id    AS user_id,
              a.project    AS project,
              a.max_id     AS max_id,
              COALESCE(upm.watermark_message_id, 0) AS watermark
         FROM active a
         LEFT JOIN user_project_memory upm
           ON upm.user_id = a.user_id AND upm.project = a.project
        WHERE COALESCE(upm.status, 'idle') != 'refreshing'
          AND a.max_id > COALESCE(upm.watermark_message_id, 0)
        ORDER BY (a.max_id - COALESCE(upm.watermark_message_id, 0)) DESC
        LIMIT ?`,
    )
    .all(systemUserId, limit) as Array<{
    user_id: string;
    project: string;
    max_id: number;
    watermark: number;
  }>;
  return rows.map((r) => ({
    userId: r.user_id,
    project: r.project,
    watermark: r.watermark,
    maxId: r.max_id,
  }));
}

/**
 * Active (agent, project) pairs that have new content past their watermark.
 * The "agent participates" predicate uses messages.author = agent — i.e. the
 * agent has authored at least one assistant turn in that project.
 */
export function listActiveAgentProjectPairs(
  db: Database,
  limit: number,
): Array<{ agent: string; project: string; watermark: number; maxId: number }> {
  const rows = db
    .prepare(
      `WITH active AS (
         SELECT m.author AS agent, COALESCE(m.project, 'general') AS project,
                (
                  SELECT MAX(m2.id) FROM messages m2
                   WHERE COALESCE(m2.project, 'general') = COALESCE(m.project, 'general')
                     AND m2.channel = 'content'
                     AND m2.role IN ('user','assistant')
                     AND m2.content IS NOT NULL AND m2.content != ''
                     AND m2.trimmed_at IS NULL
                     AND m2.from_automation = 0
                     AND m2.session_id IN (
                       SELECT DISTINCT session_id FROM messages
                        WHERE author = m.author
                          AND COALESCE(project, 'general') = COALESCE(m.project, 'general')
                          AND from_automation = 0
                     )
                ) AS max_id
           FROM messages m
          WHERE m.author IS NOT NULL AND m.author != ''
            AND m.role = 'assistant'
            AND m.channel = 'content'
            AND m.trimmed_at IS NULL
            AND m.from_automation = 0
          GROUP BY m.author, COALESCE(m.project, 'general')
       )
       SELECT a.agent, a.project, a.max_id,
              COALESCE(apm.watermark_message_id, 0) AS watermark,
              COALESCE(apm.status, 'idle')          AS status
         FROM active a
         LEFT JOIN agent_project_memory apm
           ON apm.agent = a.agent AND apm.project = a.project
        WHERE a.max_id IS NOT NULL
          AND COALESCE(apm.status, 'idle') != 'refreshing'
          AND a.max_id > COALESCE(apm.watermark_message_id, 0)
        ORDER BY (a.max_id - COALESCE(apm.watermark_message_id, 0)) DESC
        LIMIT ?`,
    )
    .all(limit) as Array<{
    agent: string;
    project: string;
    max_id: number;
    watermark: number;
  }>;
  return rows.map((r) => ({
    agent: r.agent,
    project: r.project,
    maxId: r.max_id,
    watermark: r.watermark,
  }));
}

/** Active users (with at least one content message) past their soul watermark. */
export function listActiveSoulUsers(
  db: Database,
  limit: number,
): Array<{ userId: string; watermark: number; maxId: number }> {
  // Empty string when the system user isn't seeded yet — the `user_id != ?`
  // predicate then matches every real row (no false-empty result).
  const systemUserId = getUserByUsername(db, SYSTEM_USERNAME)?.id ?? "";
  const rows = db
    .prepare(
      `WITH active AS (
         SELECT user_id, MAX(id) AS max_id
           FROM messages
          WHERE user_id IS NOT NULL
            AND user_id != ?
            AND channel = 'content'
            AND role IN ('user','assistant')
            AND content IS NOT NULL AND content != ''
            AND trimmed_at IS NULL
            AND from_automation = 0
          GROUP BY user_id
       )
       SELECT a.user_id, a.max_id, u.soul_watermark_message_id AS watermark, u.soul_status AS status
         FROM active a
         JOIN users u ON u.id = a.user_id
        WHERE COALESCE(u.soul_status, 'idle') != 'refreshing'
          AND a.max_id > COALESCE(u.soul_watermark_message_id, 0)
        ORDER BY (a.max_id - COALESCE(u.soul_watermark_message_id, 0)) DESC
        LIMIT ?`,
    )
    .all(systemUserId, limit) as Array<{
    user_id: string;
    max_id: number;
    watermark: number;
  }>;
  return rows.map((r) => ({
    userId: r.user_id,
    watermark: r.watermark,
    maxId: r.max_id,
  }));
}

function formatMessages(rows: MemoryRefreshMessage[]): string {
  if (rows.length === 0) return "(no new messages)";
  return rows
    .map((m) => {
      const speaker =
        m.role === "user"
          ? "user"
          : m.author
            ? `assistant (@${m.author})`
            : "assistant";
      return `[#${m.id}] ${speaker}: ${m.content}`;
    })
    .join("\n\n");
}

function clamp(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MEMORY_FIELD_CHAR_LIMIT) return trimmed;
  return trimmed.slice(0, MEMORY_FIELD_CHAR_LIMIT);
}

interface RefreshConfig {
  batchSize: number;
  maxMessagesPerRow: number;
  stuckThresholdMs: number;
}

function readConfig(ctx: TaskHandlerContext): RefreshConfig {
  return {
    batchSize: ctx.cfg.memory.refreshBatchSize ?? DEFAULT_BATCH_SIZE,
    maxMessagesPerRow:
      ctx.cfg.memory.refreshMaxMessagesPerRow ?? DEFAULT_MAX_MESSAGES_PER_ROW,
    stuckThresholdMs:
      ctx.cfg.memory.refreshStuckThresholdMs ?? DEFAULT_STUCK_THRESHOLD_MS,
  };
}

export async function memoryRefreshHandler(
  ctx: TaskHandlerContext,
): Promise<void> {
  const { db, queue, cfg, now } = ctx;
  const conf = readConfig(ctx);

  // 1. Reclaim stuck rows from prior crashes BEFORE we re-iterate.
  const stuckUsers = releaseStuckUserProjectMemory(
    db,
    conf.stuckThresholdMs,
    now,
  );
  const stuckAgents = releaseStuckAgentProjectMemory(
    db,
    conf.stuckThresholdMs,
    now,
  );
  const stuckSouls = releaseStuckUserSoul(db, conf.stuckThresholdMs, now);
  if (stuckUsers.length || stuckAgents.length || stuckSouls.length) {
    void queue.log({
      topic: "memory",
      kind: "sweep.stuck",
      data: {
        userProject: stuckUsers,
        agentProject: stuckAgents,
        soul: stuckSouls,
      },
    });
  }

  let budget = conf.batchSize;
  // Empty string when the system user isn't seeded yet — the `user_id != ?`
  // predicate then matches every real row (no false-empty result).
  const systemUserId = getUserByUsername(db, SYSTEM_USERNAME)?.id ?? "";

  // 2. (user, project) memory.
  const userPairs = listActiveUserProjectPairs(db, budget);
  for (const pair of userPairs) {
    if (budget <= 0) break;
    const userId = pair.userId;
    const project = pair.project;
    try {
      ensureUserProjectMemory(db, userId, project);
    } catch {
      continue;
    }
    if (!claimUserProjectMemoryForRefresh(db, userId, project, now)) continue;
    budget -= 1;
    try {
      await refreshUserProjectMemory({
        ctx,
        userId,
        project,
        watermark: pair.watermark,
        maxMessagesPerRow: conf.maxMessagesPerRow,
        runUserId: systemUserId,
      });
    } catch (e) {
      const msg = errorMessage(e);
      try {
        setUserProjectMemoryError(db, userId, project, msg);
      } catch {
        /* ignore */
      }
      void queue.log({
        topic: "memory",
        kind: "user_project.refresh.error",
        userId,
        data: { project },
        error: msg,
      });
    }
  }

  // 3. (agent, project) memory.
  if (budget > 0) {
    const agentPairs = listActiveAgentProjectPairs(db, budget);
    for (const pair of agentPairs) {
      if (budget <= 0) break;
      try {
        ensureAgentProjectMemory(db, pair.agent, pair.project);
      } catch {
        continue;
      }
      if (!claimAgentProjectMemoryForRefresh(db, pair.agent, pair.project, now))
        continue;
      budget -= 1;
      try {
        await refreshAgentProjectMemory({
          ctx,
          agent: pair.agent,
          project: pair.project,
          watermark: pair.watermark,
          maxMessagesPerRow: conf.maxMessagesPerRow,
          runUserId: systemUserId,
        });
      } catch (e) {
        const msg = errorMessage(e);
        try {
          setAgentProjectMemoryError(db, pair.agent, pair.project, msg);
        } catch {
          /* ignore */
        }
        void queue.log({
          topic: "memory",
          kind: "agent_project.refresh.error",
          data: { project: pair.project, agent: pair.agent },
          error: msg,
        });
      }
    }
  }

  // 4. User soul.
  if (budget > 0) {
    const soulCandidates = listActiveSoulUsers(db, budget);
    for (const cand of soulCandidates) {
      if (budget <= 0) break;
      if (!claimUserSoulForRefresh(db, cand.userId, now)) continue;
      budget -= 1;
      try {
        await refreshUserSoul({
          ctx,
          userId: cand.userId,
          watermark: cand.watermark,
          maxMessagesPerRow: conf.maxMessagesPerRow,
          // Soul runs as the system user — runAgent needs SOMEONE for queue ownership.
          runUserId: systemUserId,
          // The default project is reused for the recall scope; the prompt
          // override means recall results never reach the LLM anyway.
          project: cfg.agent.defaultProject,
        });
      } catch (e) {
        const msg = errorMessage(e);
        try {
          setUserSoulError(db, cand.userId, msg);
        } catch {
          /* ignore */
        }
        void queue.log({
          topic: "memory",
          kind: "user_soul.refresh.error",
          userId: cand.userId,
          error: msg,
        });
      }
    }
  }
}

// ── Per-row refresh routines ────────────────────────────────────────────────

interface RefreshArgs {
  ctx: TaskHandlerContext;
  watermark: number;
  maxMessagesPerRow: number;
  runUserId: string;
}

async function refreshUserProjectMemory(
  args: RefreshArgs & { userId: string; project: string },
): Promise<void> {
  const { ctx, userId, project, watermark, maxMessagesPerRow, runUserId } =
    args;
  const { db, queue, cfg } = ctx;

  const messages = getUserProjectMessagesAfter(
    db,
    userId,
    project,
    watermark,
    maxMessagesPerRow,
  );
  if (messages.length === 0) {
    bumpUserProjectMemoryWatermark(db, userId, project, watermark);
    return;
  }

  const current = getUserProjectMemory(db, userId, project);
  const userRow = getUserById(db, userId);
  const userDisplay =
    userRow?.displayName?.trim() || userRow?.username || `user(${userId})`;

  const systemPrompt = interpolate(
    resolvePrompt("memory.user_project.refresh", { project }),
    {
      project,
      userDisplay,
      currentMemory: current?.memory || "(empty)",
      newMessages: formatMessages(messages),
      budget: MEMORY_FIELD_CHAR_LIMIT,
    },
  );

  const sessionId = `memory-user-${crypto.randomUUID()}`;
  setSessionHiddenFromChat(db, runUserId, sessionId, true);

  void queue.log({
    topic: "memory",
    kind: "user_project.refresh.start",
    userId,
    data: {
      project,
      processed: messages.length,
      before: current?.memory.length ?? 0,
    },
  });

  const answer = await runAgent({
    prompt: "Update the memory now according to the system instructions.",
    sessionId,
    userId: runUserId,
    project,
    llmCfg: cfg.llm,
    embedCfg: cfg.embed,
    memoryCfg: cfg.memory,
    agentCfg: cfg.agent,
    tools: toolRegistry,
    db,
    queue,
    renderer: silentRenderer(),
    systemPromptOverride: systemPrompt,
    originAutomation: true,
  });

  const merged = clamp(answer);
  const lastId = messages[messages.length - 1]!.id;
  setUserProjectMemoryAuto(db, userId, project, merged, lastId);

  void queue.log({
    topic: "memory",
    kind: "user_project.refresh.done",
    userId,
    data: {
      project,
      processed: messages.length,
      before: current?.memory.length ?? 0,
      after: merged.length,
      watermark: lastId,
    },
  });
}

async function refreshAgentProjectMemory(
  args: RefreshArgs & { agent: string; project: string },
): Promise<void> {
  const { ctx, agent, project, watermark, maxMessagesPerRow, runUserId } = args;
  const { db, queue, cfg } = ctx;

  const messages = getProjectAgentMessagesAfter(
    db,
    agent,
    project,
    watermark,
    maxMessagesPerRow,
  );
  if (messages.length === 0) {
    bumpAgentProjectMemoryWatermark(db, agent, project, watermark);
    return;
  }

  const current = getAgentProjectMemory(db, agent, project);
  const agentRow = getAgent(db, agent);
  const description =
    (agentRow?.description ?? "").trim() || "(no description)";

  const systemPrompt = interpolate(
    resolvePrompt("memory.agent_project.refresh", { project }),
    {
      project,
      agentName: agent,
      agentDescription: description,
      currentMemory: current?.memory || "(empty)",
      newMessages: formatMessages(messages),
      budget: MEMORY_FIELD_CHAR_LIMIT,
    },
  );

  const sessionId = `memory-agent-${crypto.randomUUID()}`;
  setSessionHiddenFromChat(db, runUserId, sessionId, true);

  void queue.log({
    topic: "memory",
    kind: "agent_project.refresh.start",
    data: {
      project,
      agent,
      processed: messages.length,
      before: current?.memory.length ?? 0,
    },
  });

  const answer = await runAgent({
    prompt: "Update the memory now according to the system instructions.",
    sessionId,
    userId: runUserId,
    project,
    llmCfg: cfg.llm,
    embedCfg: cfg.embed,
    memoryCfg: cfg.memory,
    agentCfg: cfg.agent,
    tools: toolRegistry,
    db,
    queue,
    renderer: silentRenderer(),
    systemPromptOverride: systemPrompt,
    originAutomation: true,
  });

  const merged = clamp(answer);
  const lastId = messages[messages.length - 1]!.id;
  setAgentProjectMemoryAuto(db, agent, project, merged, lastId);

  void queue.log({
    topic: "memory",
    kind: "agent_project.refresh.done",
    data: {
      project,
      agent,
      processed: messages.length,
      before: current?.memory.length ?? 0,
      after: merged.length,
      watermark: lastId,
    },
  });
}

async function refreshUserSoul(
  args: RefreshArgs & { userId: string; project: string },
): Promise<void> {
  const { ctx, userId, watermark, maxMessagesPerRow, runUserId, project } =
    args;
  const { db, queue, cfg } = ctx;

  const messages = getUserMessagesAfter(
    db,
    userId,
    watermark,
    maxMessagesPerRow,
  );
  if (messages.length === 0) {
    bumpUserSoulWatermark(db, userId, watermark);
    return;
  }

  const userRow = getUserById(db, userId);
  if (!userRow) return;
  const userDisplay =
    userRow.displayName?.trim() || userRow.username || `user(${userId})`;

  const currentSoul = userRow.soul ?? "";
  const systemPrompt = interpolate(resolvePrompt("memory.user_soul.refresh"), {
    userDisplay,
    currentSoul: currentSoul || "(empty)",
    newMessages: formatMessages(messages),
    budget: MEMORY_FIELD_CHAR_LIMIT,
  });

  const sessionId = `memory-soul-${crypto.randomUUID()}`;
  setSessionHiddenFromChat(db, runUserId, sessionId, true);

  void queue.log({
    topic: "memory",
    kind: "user_soul.refresh.start",
    userId,
    data: { processed: messages.length, before: currentSoul.length },
  });

  const answer = await runAgent({
    prompt: "Update the soul now according to the system instructions.",
    sessionId,
    userId: runUserId,
    project,
    llmCfg: cfg.llm,
    embedCfg: cfg.embed,
    memoryCfg: cfg.memory,
    agentCfg: cfg.agent,
    tools: toolRegistry,
    db,
    queue,
    renderer: silentRenderer(),
    systemPromptOverride: systemPrompt,
    originAutomation: true,
  });

  const merged = clamp(answer);
  const lastId = messages[messages.length - 1]!.id;
  setUserSoulAuto(db, userId, merged, lastId);

  void queue.log({
    topic: "memory",
    kind: "user_soul.refresh.done",
    userId,
    data: {
      processed: messages.length,
      before: currentSoul.length,
      after: merged.length,
      watermark: lastId,
    },
  });
}

export function registerMemoryRefresh(registry: HandlerRegistry): void {
  registry.register(MEMORY_REFRESH_HANDLER, memoryRefreshHandler);
}
