import { afterEach, describe, expect, test } from "bun:test";
import {
  acquireTelegramSlot,
  resetTelegramRateLimits,
} from "../../src/telegram/rate_limit.ts";

afterEach(() => {
  resetTelegramRateLimits();
});

describe("acquireTelegramSlot", () => {
  test("fresh bucket allows `capacity` immediate acquires", async () => {
    const tail = "abcd";
    const capacity = 5;
    for (let i = 0; i < capacity; i++) {
      await acquireTelegramSlot({
        tokenTail: tail,
        globalPerSec: capacity,
        perChatPerSec: 10,
      });
    }
    // The next one must wait — don't actually block the test, just time it.
    const start = Date.now();
    const p = acquireTelegramSlot({
      tokenTail: tail,
      globalPerSec: capacity,
      perChatPerSec: 10,
    });
    // Wait for slight progress (~100ms) to prove we actually blocked.
    await Promise.race([p, new Promise((r) => setTimeout(r, 50))]);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40);
    await p; // drain so the next test starts clean
  });

  test("per-chat bucket bounds throughput for the same chat", async () => {
    const tail = "xxxx";
    // Give us a huge global bucket so only the per-chat rate matters.
    await acquireTelegramSlot({
      tokenTail: tail,
      chatId: 99,
      globalPerSec: 1000,
      perChatPerSec: 1,
    });
    const start = Date.now();
    await acquireTelegramSlot({
      tokenTail: tail,
      chatId: 99,
      globalPerSec: 1000,
      perChatPerSec: 1,
    });
    // Second acquire needs 1 token at 1/s → ~1 s wait. Allow a generous
    // margin for CI jitter but reject "instant" (which would mean the bucket
    // isn't actually rate-limiting).
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(500);
  });
});
