import { describe, expect, test } from "bun:test";
import { createConcurrencyGate } from "../../src/llm/concurrency_gate.ts";

describe("createConcurrencyGate", () => {
  test("rejects non-positive caps at construction", () => {
    expect(() => createConcurrencyGate(0)).toThrow();
    expect(() => createConcurrencyGate(-1)).toThrow();
    expect(() => createConcurrencyGate(1.5)).toThrow();
  });

  test("acquire below cap returns initialPosition 0 and a pre-resolved ready", async () => {
    const gate = createConcurrencyGate(2);
    const t1 = gate.acquire();
    expect(t1.initialPosition).toBe(0);
    expect(gate.getInFlight()).toBe(1);
    expect(gate.getQueued()).toBe(0);
    expect((await t1.ready).waitedMs).toBe(0);

    const t2 = gate.acquire();
    expect(t2.initialPosition).toBe(0);
    expect(gate.getInFlight()).toBe(2);
    await t2.ready;
  });

  test("acquire at cap reports its initial position and waits for release", async () => {
    const gate = createConcurrencyGate(1);
    const t1 = gate.acquire();
    await t1.ready; // 1 in flight

    const t2 = gate.acquire();
    expect(t2.initialPosition).toBe(1);
    expect(gate.getQueued()).toBe(1);

    let resolved = false;
    const ready2 = t2.ready.then((r) => {
      resolved = true;
      return r;
    });
    expect(resolved).toBe(false);

    gate.release();
    const r2 = await ready2;
    expect(resolved).toBe(true);
    expect(r2.waitedMs).toBeGreaterThanOrEqual(0);
    expect(gate.getInFlight()).toBe(1);
    expect(gate.getQueued()).toBe(0);
  });

  test("FIFO: five parallel acquires at cap=1 resolve in order with ascending positions", async () => {
    const gate = createConcurrencyGate(1);
    const positions: number[] = [];
    const order: number[] = [];
    const promises: Promise<void>[] = [];
    for (let i = 0; i < 5; i++) {
      const t = gate.acquire();
      positions.push(t.initialPosition);
      promises.push(
        t.ready.then(() => {
          order.push(i);
        }),
      );
    }

    expect(positions).toEqual([0, 1, 2, 3, 4]);
    expect(gate.getInFlight()).toBe(1);
    expect(gate.getQueued()).toBe(4);

    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
      gate.release();
    }
    await Promise.all(promises);
    expect(order).toEqual([0, 1, 2, 3, 4]);
    expect(gate.getInFlight()).toBe(0);
    expect(gate.getQueued()).toBe(0);
  });

  test("setCap(higher) drains waiters up to the new cap", async () => {
    const gate = createConcurrencyGate(1);
    await gate.acquire().ready;
    let resolvedCount = 0;
    for (let i = 0; i < 3; i++) {
      void gate.acquire().ready.then(() => {
        resolvedCount++;
      });
    }
    expect(gate.getQueued()).toBe(3);

    gate.setCap(3);
    await Promise.resolve();
    await Promise.resolve();
    expect(resolvedCount).toBe(2);
    expect(gate.getInFlight()).toBe(3);
    expect(gate.getQueued()).toBe(1);
  });

  test("setCap(lower) does not abort running calls; only future acquires bind", async () => {
    const gate = createConcurrencyGate(3);
    await gate.acquire().ready;
    await gate.acquire().ready;
    await gate.acquire().ready;
    expect(gate.getInFlight()).toBe(3);

    gate.setCap(1);
    expect(gate.getInFlight()).toBe(3);

    let fourthResolved = false;
    void gate.acquire().ready.then(() => {
      fourthResolved = true;
    });
    await Promise.resolve();
    expect(fourthResolved).toBe(false);

    gate.release();
    await Promise.resolve();
    expect(fourthResolved).toBe(false);
    gate.release();
    await Promise.resolve();
    expect(fourthResolved).toBe(false);
    gate.release();
    await Promise.resolve();
    expect(fourthResolved).toBe(true);
  });

  test("queuedSinceMs reflects acquire-time and waitedMs reflects the wait", async () => {
    const gate = createConcurrencyGate(1);
    await gate.acquire().ready;

    const t0 = Date.now();
    const t = gate.acquire();
    expect(t.queuedSinceMs).toBeGreaterThanOrEqual(t0);
    expect(t.queuedSinceMs).toBeLessThanOrEqual(t0 + 5);

    await new Promise((r) => setTimeout(r, 20));
    gate.release();
    const { waitedMs } = await t.ready;
    expect(waitedMs).toBeGreaterThanOrEqual(15);
  });

  test("release() with inFlight=0 is a safe no-op", () => {
    const gate = createConcurrencyGate(1);
    expect(() => gate.release()).not.toThrow();
    expect(gate.getInFlight()).toBe(0);
  });
});
