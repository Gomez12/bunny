/**
 * Shared SSE fanout for detached runners (board card runs, workflow runs,
 * future subsystems). A fanout buffers every SSE-encoded chunk emitted by
 * the detached task so late subscribers replay from the start. Once the
 * run closes, subscribers are disconnected and the fanout is dropped
 * from the registry after a short TTL so a brand-new subscriber arriving
 * right after the response can still replay once.
 *
 * See `src/board/run_card.ts` + `src/workflows/run_workflow.ts` for
 * concrete consumers.
 */

import type { SseSink } from "./render_sse.ts";
import type { SseEvent } from "./sse_events.ts";

/**
 * Replay-buffer cap in bytes. Prevents long-running workflows (30 min of
 * reasoning streams, heavy tool output) from pinning multi-MB of buffered
 * SSE chunks in memory indefinitely. Late subscribers get the most recent
 * tail; historical content is available from the DB once the run finishes.
 */
const DEFAULT_REPLAY_CAP_BYTES = 2 * 1024 * 1024;

/** Post-close TTL so a subscriber that opens right after the response can still replay once. */
const DEFAULT_DROP_DELAY_MS = 60_000;

export interface Fanout<Meta extends object = object> {
  readonly runId: number;
  /** Caller-defined metadata (e.g. sessionId, cancelRequested) — stored on the fanout so auxiliary routes can read it without a second DB hit. */
  meta: Meta;
  /** Replay buffer of raw SSE-encoded chunks. Capped at `replayCapBytes`. */
  buffer: Uint8Array[];
  /** Running total of `buffer` byte length — avoids re-summing on every append. */
  bufferBytes: number;
  subscribers: Set<SseSink>;
  closed: boolean;
}

const encoder = new TextEncoder();

/**
 * Centralised registry. Each subsystem gets its own namespaced map so
 * runIds from different domains (card runs, workflow runs) don't collide.
 */
export type FanoutRegistry<Meta extends object = object> = Map<
  number,
  Fanout<Meta>
>;

export function createFanoutRegistry<
  Meta extends object = object,
>(): FanoutRegistry<Meta> {
  return new Map();
}

export interface CreateFanoutOpts<Meta extends object> {
  runId: number;
  meta: Meta;
  replayCapBytes?: number;
  dropDelayMs?: number;
}

export interface FanoutHandle<Meta extends object> {
  fanout: Fanout<Meta>;
  sink: SseSink;
}

/**
 * Build and register a new fanout + its sink. The sink's `enqueue` mirrors
 * to all current subscribers and records into the replay buffer; `close`
 * drops the subscribers + schedules the fanout for removal.
 */
export function createFanout<Meta extends object>(
  registry: FanoutRegistry<Meta>,
  opts: CreateFanoutOpts<Meta>,
): FanoutHandle<Meta> {
  const cap = opts.replayCapBytes ?? DEFAULT_REPLAY_CAP_BYTES;
  const drop = opts.dropDelayMs ?? DEFAULT_DROP_DELAY_MS;
  const fanout: Fanout<Meta> = {
    runId: opts.runId,
    meta: opts.meta,
    buffer: [],
    bufferBytes: 0,
    subscribers: new Set(),
    closed: false,
  };
  registry.set(opts.runId, fanout);

  const sink: SseSink = {
    enqueue(chunk) {
      if (fanout.closed) return;
      fanout.buffer.push(chunk);
      fanout.bufferBytes += chunk.byteLength;
      // Drop from the front until we're back under the cap. Late subscribers
      // lose the oldest chunks but can read historical log_text from the DB.
      while (fanout.bufferBytes > cap && fanout.buffer.length > 1) {
        const shed = fanout.buffer.shift()!;
        fanout.bufferBytes -= shed.byteLength;
      }
      for (const sub of fanout.subscribers) sub.enqueue(chunk);
    },
    close() {
      if (fanout.closed) return;
      fanout.closed = true;
      for (const sub of fanout.subscribers) sub.close();
      fanout.subscribers.clear();
      setTimeout(() => registry.delete(fanout.runId), drop).unref?.();
    },
  };

  return { fanout, sink };
}

/**
 * Subscribe to a live fanout. Replays the buffered history first. If the
 * run has already finished, flushes the buffer and closes the sink.
 * Returns an unsubscribe function.
 */
export function subscribeFanout<Meta extends object>(
  registry: FanoutRegistry<Meta>,
  runId: number,
  sink: SseSink,
): () => void {
  const fan = registry.get(runId);
  if (!fan) return () => undefined;
  for (const chunk of fan.buffer) sink.enqueue(chunk);
  if (fan.closed) {
    sink.close();
    return () => undefined;
  }
  fan.subscribers.add(sink);
  return () => fan.subscribers.delete(sink);
}

/**
 * Encode + enqueue one SSE event. Callers typed their payload with their
 * own event-union (board events, workflow events); the generic `SseEvent`
 * union on the backend accepts both.
 */
export function sendSseEvent(sink: SseSink, payload: SseEvent): void {
  sink.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
}
