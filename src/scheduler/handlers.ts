/**
 * Handler registry for scheduled tasks.
 *
 * The scheduler subsystem itself is deliberately ignorant of what handlers do.
 * Domain modules (e.g. `src/board/auto_run_handler.ts`) register themselves by
 * name; the ticker looks the name up per task row and invokes the callback.
 *
 * This file has no dependencies on boards, agents, or any other domain.
 */

import type { Database } from "bun:sqlite";
import type { BunnyConfig } from "../config.ts";
import type { BunnyQueue } from "../queue/bunqueue.ts";
import type { ScheduledTask } from "../memory/scheduled_tasks.ts";

export interface TaskHandlerContext {
  db: Database;
  queue: BunnyQueue;
  cfg: BunnyConfig;
  task: ScheduledTask;
  payload: unknown;
  /** Current tick timestamp (ms since epoch). */
  now: number;
}

export type TaskHandler = (ctx: TaskHandlerContext) => Promise<void> | void;

export interface HandlerRegistry {
  register(name: string, handler: TaskHandler): void;
  get(name: string): TaskHandler | undefined;
  list(): string[];
  /** Remove a handler (primarily for tests). */
  unregister(name: string): void;
  /** Clear all handlers (primarily for tests). */
  reset(): void;
}

export function createHandlerRegistry(): HandlerRegistry {
  const handlers = new Map<string, TaskHandler>();
  return {
    register(name, handler) {
      handlers.set(name, handler);
    },
    get(name) {
      return handlers.get(name);
    },
    list() {
      return [...handlers.keys()].sort();
    },
    unregister(name) {
      handlers.delete(name);
    },
    reset() {
      handlers.clear();
    },
  };
}

/**
 * The process-wide default registry. Domain modules register on import; the
 * server passes this same instance to `startScheduler`.
 */
export const defaultHandlerRegistry: HandlerRegistry = createHandlerRegistry();
