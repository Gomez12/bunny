import { afterAll, beforeAll, describe, expect, test } from "bun:test";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Server = any;
import type { LlmConfig } from "../../src/config.ts";
import { chat, chatSync } from "../../src/llm/adapter.ts";
import { createConcurrencyGate } from "../../src/llm/concurrency_gate.ts";

function buildSseBody(chunks: unknown[]): string {
  return (
    chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") +
    "data: [DONE]\n\n"
  );
}

function makeContentChunk(content: string): unknown {
  return {
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  };
}

let server: Server;
let baseUrl: string;
let serverDelayMs = 0;
let activeRequests = 0;
let maxObservedActive = 0;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch() {
      activeRequests++;
      maxObservedActive = Math.max(maxObservedActive, activeRequests);
      try {
        if (serverDelayMs > 0) {
          await new Promise((r) => setTimeout(r, serverDelayMs));
        }
        const body = buildSseBody([makeContentChunk("ok")]);
        return new Response(body, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
          },
        });
      } finally {
        activeRequests--;
      }
    },
  });
  baseUrl = `http://localhost:${server.port}/v1`;
});

afterAll(() => {
  server.stop(true);
});

function cfg(): LlmConfig {
  return {
    baseUrl,
    apiKey: "",
    model: "test-model",
    modelReasoning: undefined,
    profile: "openai",
    maxConcurrentRequests: 1,
  };
}

describe("chat() concurrency gate integration", () => {
  test("no opts: chat() works exactly like before (no callbacks fired)", async () => {
    serverDelayMs = 0;
    const res = await chatSync(cfg(), {
      messages: [{ role: "user", content: "x" }],
    });
    expect(res.message.content).toBe("ok");
  });

  test("cap=1 serialises three parallel calls; only one upstream request is active at a time", async () => {
    serverDelayMs = 30;
    activeRequests = 0;
    maxObservedActive = 0;

    const gate = createConcurrencyGate(1);
    const order: string[] = [];

    async function runOne(label: string): Promise<void> {
      await chatSync(
        cfg(),
        { messages: [{ role: "user", content: label }] },
        {
          gate,
          onQueueWait: (ev) => order.push(`${label}:wait@${ev.position}`),
          onQueueRelease: () => order.push(`${label}:release`),
        },
      );
      order.push(`${label}:done`);
    }

    await Promise.all([runOne("a"), runOne("b"), runOne("c")]);

    // The upstream may never have observed two requests in flight.
    expect(maxObservedActive).toBe(1);

    // First call: no wait. Second + third: wait then release.
    expect(order.filter((s) => s.endsWith(":wait@1")).length).toBe(1);
    expect(order.filter((s) => s.endsWith(":wait@2")).length).toBe(1);
    expect(order.filter((s) => s.endsWith(":release")).length).toBe(2);
    expect(order.filter((s) => s.endsWith(":done")).length).toBe(3);

    // Each "release" precedes its own "done".
    const aRelease = order.indexOf("a:release");
    const aDone = order.indexOf("a:done");
    const bRelease = order.indexOf("b:release");
    const bDone = order.indexOf("b:done");
    if (aRelease !== -1) expect(aRelease).toBeLessThan(aDone);
    if (bRelease !== -1) expect(bRelease).toBeLessThan(bDone);

    expect(gate.getInFlight()).toBe(0);
    expect(gate.getQueued()).toBe(0);
  });

  test("cap=2 lets two upstream requests overlap; third waits", async () => {
    serverDelayMs = 30;
    activeRequests = 0;
    maxObservedActive = 0;

    const gate = createConcurrencyGate(2);
    let waitedCount = 0;

    await Promise.all([
      chatSync(
        cfg(),
        { messages: [{ role: "user", content: "1" }] },
        {
          gate,
          onQueueWait: () => waitedCount++,
        },
      ),
      chatSync(
        cfg(),
        { messages: [{ role: "user", content: "2" }] },
        {
          gate,
          onQueueWait: () => waitedCount++,
        },
      ),
      chatSync(
        cfg(),
        { messages: [{ role: "user", content: "3" }] },
        {
          gate,
          onQueueWait: () => waitedCount++,
        },
      ),
    ]);

    expect(waitedCount).toBe(1); // only the third was queued
    expect(maxObservedActive).toBeGreaterThanOrEqual(1);
    expect(maxObservedActive).toBeLessThanOrEqual(2);
    expect(gate.getInFlight()).toBe(0);
  });

  test("error from fetch releases the gate", async () => {
    serverDelayMs = 0;
    const gate = createConcurrencyGate(1);

    // Point at a closed port so fetch fails without ever streaming.
    const badCfg: LlmConfig = { ...cfg(), baseUrl: "http://127.0.0.1:1/v1" };

    let threw = false;
    try {
      await chat(
        badCfg,
        { messages: [{ role: "user", content: "x" }] },
        {
          gate,
        },
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(gate.getInFlight()).toBe(0);
    expect(gate.getQueued()).toBe(0);

    // Subsequent acquire still works.
    const t = gate.acquire();
    expect(t.initialPosition).toBe(0);
    await t.ready;
    gate.release();
  });

  test("HTTP error response releases the gate (non-2xx)", async () => {
    const errServer = Bun.serve({
      port: 0,
      fetch: () => new Response("server boom", { status: 500 }),
    });
    const errBase = `http://localhost:${errServer.port}/v1`;
    const errCfg: LlmConfig = { ...cfg(), baseUrl: errBase };

    const gate = createConcurrencyGate(1);
    let threw = false;
    try {
      await chat(
        errCfg,
        { messages: [{ role: "user", content: "x" }] },
        {
          gate,
        },
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(gate.getInFlight()).toBe(0);
    errServer.stop(true);
  });
});
