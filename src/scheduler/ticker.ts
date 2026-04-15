/**
 * Scheduler ticker.
 *
 * A tiny in-process scheduler that fires once per minute. Each tick claims all
 * enabled `scheduled_tasks` rows whose `next_run_at` has passed, invokes the
 * registered handler for each, and records the outcome + the cron-derived next
 * firing timestamp. Handler errors are caught per-task so one failure never
 * blocks other tasks.
 *
 * The scheduler is deliberately domain-agnostic — it knows nothing about
 * boards, agents, or any other subsystem. Handlers register themselves with a
 * `HandlerRegistry`; the ticker looks them up by name.
 */

import type { Database } from "bun:sqlite";
import type { BunnyConfig } from "../config.ts";
import type { BunnyQueue } from "../queue/bunqueue.ts";
import {
  claimDueTasks,
  getTask,
  setTaskResult,
  type ScheduledTask,
} from "../memory/scheduled_tasks.ts";
import { computeNextRun } from "./cron.ts";
import type { HandlerRegistry } from "./handlers.ts";
import { errorMessage } from "../util/error.ts";

const TICK_MS = 60_000;

export interface SchedulerHandle {
  stop(): void;
  /** Run one tick synchronously — exposed for tests and the run-now endpoint. */
  tick(now?: number): Promise<void>;
  /** Tick a single task by id on demand. */
  runTask(taskId: string, now?: number): Promise<void>;
}

export interface StartSchedulerOpts {
  db: Database;
  queue: BunnyQueue;
  cfg: BunnyConfig;
  registry: HandlerRegistry;
  /** Override the tick interval (tests). */
  intervalMs?: number;
  /** Skip setInterval entirely — for tests. */
  manual?: boolean;
  /** Delay before the first tick. Defaults to 5000. */
  initialDelayMs?: number;
}

export function startScheduler(opts: StartSchedulerOpts): SchedulerHandle {
  const { db, queue, cfg, registry } = opts;

  const runHandler = async (task: ScheduledTask, now: number): Promise<void> => {
    const handler = registry.get(task.handler);
    const ranAt = now;
    if (!handler) {
      const msg = `no handler registered for '${task.handler}'`;
      const next = safeNext(task.cronExpr, now);
      setTaskResult(db, task.id, {
        status: "error",
        error: msg,
        nextRunAt: next,
        ranAt,
      });
      void queue.log({
        topic: "scheduler",
        kind: "error",
        data: { taskId: task.id, handler: task.handler },
        error: msg,
      });
      return;
    }
    const started = Date.now();
    try {
      await handler({ db, queue, cfg, task, payload: task.payload, now });
      const next = safeNext(task.cronExpr, now);
      setTaskResult(db, task.id, {
        status: "ok",
        error: null,
        nextRunAt: next,
        ranAt,
      });
      void queue.log({
        topic: "scheduler",
        kind: "tick",
        data: { taskId: task.id, handler: task.handler },
        durationMs: Date.now() - started,
      });
    } catch (e) {
      const msg = errorMessage(e);
      const next = safeNext(task.cronExpr, now);
      setTaskResult(db, task.id, {
        status: "error",
        error: msg,
        nextRunAt: next,
        ranAt,
      });
      void queue.log({
        topic: "scheduler",
        kind: "error",
        data: { taskId: task.id, handler: task.handler },
        durationMs: Date.now() - started,
        error: msg,
      });
    }
  };

  const tick = async (now: number = Date.now()): Promise<void> => {
    let due: ScheduledTask[];
    try {
      due = claimDueTasks(db, now);
    } catch (e) {
      void queue.log({
        topic: "scheduler",
        kind: "error",
        error: `claimDueTasks failed: ${errorMessage(e)}`,
      });
      return;
    }
    for (const task of due) {
      await runHandler(task, now);
    }
  };

  const runTask = async (taskId: string, now: number = Date.now()): Promise<void> => {
    const task = getTask(db, taskId);
    if (!task) throw new Error(`scheduled task ${taskId} not found`);
    await runHandler(task, now);
  };

  if (opts.manual) {
    return { stop: () => undefined, tick, runTask };
  }

  const intervalMs = opts.intervalMs ?? TICK_MS;
  const initialDelay = opts.initialDelayMs ?? 5_000;
  let interval: ReturnType<typeof setInterval> | null = null;
  const initial = setTimeout(() => {
    void tick();
    interval = setInterval(() => {
      void tick();
    }, intervalMs);
    interval.unref?.();
  }, initialDelay);
  initial.unref?.();

  return {
    stop() {
      clearTimeout(initial);
      if (interval) clearInterval(interval);
    },
    tick,
    runTask,
  };
}

function safeNext(expr: string, now: number): number {
  try {
    return computeNextRun(expr, now);
  } catch {
    // Malformed cron: park the task one hour out so the ticker keeps progressing
    // instead of re-raising every minute. Admins can fix and run-now.
    return now + 3_600_000;
  }
}
