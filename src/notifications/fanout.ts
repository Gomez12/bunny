/**
 * Per-user notifications fanout.
 *
 * Modelled on `src/board/run_card.ts:RunFanout` with two differences:
 *
 * 1. **No replay buffer.** User streams are long-lived (hours or days); a
 *    growing per-user buffer would leak memory for no win — late subscribers
 *    (new tabs, reconnects) just call `GET /api/notifications` for history.
 * 2. **Keepalive pings.** Corporate proxies, the Tauri webview and some
 *    browser middle boxes close idle SSE connections silently. A 25 s
 *    comment-line ping keeps the connection warm. The existing
 *    `openSseStream` frame parser on the web side already ignores non-`data:`
 *    lines, so no frontend change is required.
 *
 * The map entry is dropped when the last subscriber for a user disconnects
 * (or on explicit `closeAllFor`, called from the logout handler).
 */

import type { SseSink } from "../agent/render_sse.ts";
import type { SseEvent } from "../agent/sse_events.ts";

const encoder = new TextEncoder();
const KEEPALIVE_INTERVAL_MS = 25_000;

interface Entry {
  subscribers: Set<SseSink>;
  keepalive: ReturnType<typeof setInterval> | null;
}

const fanouts = new Map<string, Entry>();

function ensureEntry(userId: string): Entry {
  const existing = fanouts.get(userId);
  if (existing) return existing;
  const entry: Entry = { subscribers: new Set(), keepalive: null };
  fanouts.set(userId, entry);
  return entry;
}

function startKeepalive(entry: Entry): void {
  if (entry.keepalive) return;
  entry.keepalive = setInterval(() => {
    const chunk = encoder.encode(`: ping\n\n`);
    for (const sub of entry.subscribers) sub.enqueue(chunk);
  }, KEEPALIVE_INTERVAL_MS);
  entry.keepalive?.unref?.();
}

function stopKeepalive(entry: Entry): void {
  if (!entry.keepalive) return;
  clearInterval(entry.keepalive);
  entry.keepalive = null;
}

/**
 * Subscribe `sink` to notifications for `userId`. Returns an unsubscribe
 * function. Starts the keepalive loop on first subscriber; stops it and
 * drops the map entry when the last subscriber leaves.
 */
export function subscribeUser(userId: string, sink: SseSink): () => void {
  const entry = ensureEntry(userId);
  entry.subscribers.add(sink);
  if (entry.subscribers.size === 1) startKeepalive(entry);
  return () => {
    entry.subscribers.delete(sink);
    if (entry.subscribers.size === 0) {
      stopKeepalive(entry);
      fanouts.delete(userId);
    }
  };
}

/** Broadcast an SSE event to every live subscriber for `userId`. */
export function publish(userId: string, event: SseEvent): void {
  const entry = fanouts.get(userId);
  if (!entry || entry.subscribers.size === 0) return;
  const chunk = encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
  for (const sub of entry.subscribers) sub.enqueue(chunk);
}

/**
 * Close every live subscriber for `userId` and drop the map entry. Called
 * from the logout handler so a revoked session doesn't leave a subscriber
 * hanging on the server.
 */
export function closeAllFor(userId: string): void {
  const entry = fanouts.get(userId);
  if (!entry) return;
  stopKeepalive(entry);
  for (const sub of entry.subscribers) sub.close();
  entry.subscribers.clear();
  fanouts.delete(userId);
}

/** Test / diagnostic helpers. */
export function subscriberCount(userId: string): number {
  return fanouts.get(userId)?.subscribers.size ?? 0;
}

export function hasFanout(userId: string): boolean {
  return fanouts.has(userId);
}
