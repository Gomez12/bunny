/**
 * Per-token token-bucket rate limiter.
 *
 * Telegram's Bot API enforces two headline limits:
 *   - 30 messages/second global per bot
 *   - 1 message/second per chat (more per group, but we don't do groups v1)
 *
 * Hitting these returns 429 with a `retry_after` hint. The server would then
 * drop outbound notifications silently, which is awful UX — better to throttle
 * ourselves.
 *
 * Implementation: a pair of token buckets per bot token. Each `acquire(chatId)`
 * takes one global token and one per-chat token, sleeping as needed. Buckets
 * are plain objects; state is in-process only (one bot, one Bunny instance →
 * not a concern for v1).
 */

interface Bucket {
  capacity: number;
  tokens: number;
  refillPerSec: number;
  lastRefill: number;
}

interface TokenLimiter {
  global: Bucket;
  perChat: Map<number, Bucket>;
}

const limiters = new Map<string, TokenLimiter>();

/**
 * Chat buckets that haven't been touched in this long are evicted on the
 * next acquire. Bounds the in-memory footprint for a bot that talks to many
 * unique chats over a long-running process.
 */
const PERCHAT_IDLE_EVICT_MS = 24 * 60 * 60 * 1000;

function ensureLimiter(tokenTail: string, globalPerSec: number): TokenLimiter {
  let l = limiters.get(tokenTail);
  if (l) return l;
  l = {
    global: {
      capacity: globalPerSec,
      tokens: globalPerSec,
      refillPerSec: globalPerSec,
      lastRefill: Date.now(),
    },
    perChat: new Map(),
  };
  limiters.set(tokenTail, l);
  return l;
}

function evictIdleBuckets(limiter: TokenLimiter, now: number): void {
  if (limiter.perChat.size < 64) return;
  const cutoff = now - PERCHAT_IDLE_EVICT_MS;
  for (const [id, bucket] of limiter.perChat) {
    if (bucket.lastRefill < cutoff) limiter.perChat.delete(id);
  }
}

function refill(bucket: Bucket, now: number): void {
  const elapsedMs = now - bucket.lastRefill;
  if (elapsedMs <= 0) return;
  bucket.tokens = Math.min(
    bucket.capacity,
    bucket.tokens + (elapsedMs / 1000) * bucket.refillPerSec,
  );
  bucket.lastRefill = now;
}

function waitMs(bucket: Bucket): number {
  if (bucket.tokens >= 1) return 0;
  const needed = 1 - bucket.tokens;
  return Math.ceil((needed / bucket.refillPerSec) * 1000);
}

export interface RateLimitOpts {
  tokenTail: string;
  chatId?: number;
  globalPerSec?: number;
  perChatPerSec?: number;
}

/**
 * Block until a global (and, if `chatId` is given, per-chat) token is
 * available. Consumes one token from each bucket on return.
 */
export async function acquireTelegramSlot(opts: RateLimitOpts): Promise<void> {
  const globalPerSec = opts.globalPerSec ?? 30;
  const perChatPerSec = opts.perChatPerSec ?? 1;
  const limiter = ensureLimiter(opts.tokenTail, globalPerSec);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const now = Date.now();
    refill(limiter.global, now);
    let chatBucket: Bucket | undefined;
    if (opts.chatId !== undefined) {
      evictIdleBuckets(limiter, now);
      chatBucket = limiter.perChat.get(opts.chatId);
      if (!chatBucket) {
        chatBucket = {
          capacity: perChatPerSec,
          tokens: perChatPerSec,
          refillPerSec: perChatPerSec,
          lastRefill: now,
        };
        limiter.perChat.set(opts.chatId, chatBucket);
      } else {
        refill(chatBucket, now);
      }
    }
    const wait = Math.max(
      waitMs(limiter.global),
      chatBucket ? waitMs(chatBucket) : 0,
    );
    if (wait === 0) {
      limiter.global.tokens -= 1;
      if (chatBucket) chatBucket.tokens -= 1;
      return;
    }
    await new Promise((r) => setTimeout(r, wait));
  }
}

/** Test helper: clear all limiters. */
export function resetTelegramRateLimits(): void {
  limiters.clear();
}
