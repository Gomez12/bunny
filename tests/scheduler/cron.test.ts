import { describe, expect, test } from "bun:test";
import { computeNextRun, parseCron } from "../../src/scheduler/cron.ts";

describe("cron parser", () => {
  test("rejects malformed expressions", () => {
    expect(() => parseCron("* * *")).toThrow();
    expect(() => parseCron("60 * * * *")).toThrow();
    expect(() => parseCron("*/0 * * * *")).toThrow();
  });

  test("*/5 every 5 minutes", () => {
    const from = Date.UTC(2026, 0, 1, 12, 0, 0); // 12:00:00 exactly
    const next = computeNextRun("*/5 * * * *", from);
    expect(next).toBe(Date.UTC(2026, 0, 1, 12, 5, 0));
  });

  test("advances past the current minute", () => {
    const from = Date.UTC(2026, 0, 1, 12, 5, 30); // 12:05:30
    const next = computeNextRun("*/5 * * * *", from);
    expect(next).toBe(Date.UTC(2026, 0, 1, 12, 10, 0));
  });

  test("fixed hour daily", () => {
    const from = Date.UTC(2026, 0, 1, 12, 0, 0);
    const next = computeNextRun("0 3 * * *", from);
    expect(next).toBe(Date.UTC(2026, 0, 2, 3, 0, 0));
  });
});
