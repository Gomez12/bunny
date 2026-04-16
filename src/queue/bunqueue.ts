/**
 * Bunny queue spine.
 *
 * Every meaningful action in the agent (LLM request, tool call, memory index)
 * is pushed as a job to an embedded bunqueue instance. A logging middleware
 * persists every job's input, output, duration, and any error to the `events`
 * table in SQLite — giving a complete, queryable audit trail.
 *
 * Usage:
 *   const q = createBunnyQueue(db);
 *   await q.log({ topic: "llm", kind: "request", sessionId, payload: { ... } });
 *
 * The queue runs embedded (same process, same event loop). Jobs are fire-and-
 * forget: the agent loop does not wait for the logger to finish before
 * continuing. The logging happens asynchronously but durably (WAL SQLite).
 */

import { Bunqueue } from "bunqueue/client";
import type { Database } from "bun:sqlite";
import { insertEvent } from "./events.ts";

/** Payload shape for every logging job. */
export interface LogPayload {
  topic: string;
  kind: string;
  sessionId?: string;
  userId?: string;
  data?: unknown;
  result?: unknown;
  durationMs?: number;
  error?: string;
}

/** Returned handle for pushing log events. */
export interface BunnyQueue {
  /** Push a log event. Fire-and-forget — does not block the agent loop. */
  log(payload: LogPayload): Promise<void>;
  /** Gracefully shut down the queue (flushes remaining jobs). */
  close(): Promise<void>;
}

/**
 * Create the logging queue. Must be called once at agent startup.
 *
 * @param db - Open database instance where events will be written.
 */
let _instanceCounter = 0;

export function createBunnyQueue(db: Database): BunnyQueue {
  const name = `bunny-log-${++_instanceCounter}`;
  const q = new Bunqueue<LogPayload, void>(name, {
    embedded: true,
    processor: async (job) => {
      const p = job.data;
      insertEvent(db, {
        topic: p.topic,
        kind: p.kind,
        sessionId: p.sessionId,
        userId: p.userId,
        payloadJson: p.data !== undefined ? JSON.stringify(p.data) : undefined,
        durationMs: p.durationMs,
        error: p.error,
      });
    },
  });

  // Log failures to stderr — don't let logging errors crash the agent.
  q.on("failed", (job, err) => {
    process.stderr.write(`[bunny/queue] log job failed: ${err.message}\n`);
  });

  return {
    async log(payload: LogPayload): Promise<void> {
      await q.add("log", payload);
    },
    async close(): Promise<void> {
      // Drain: wait until the queue is empty before stopping.
      await new Promise<void>((resolve) => {
        const check = () => {
          if (q.count() === 0) return resolve();
          setTimeout(check, 20);
        };
        setTimeout(check, 20);
      });
      q.pause();
    },
  };
}
