import { expect, test } from "bun:test";

test("scaffold sanity — bun:test runs and TS is wired", () => {
  const greeting: string = "bunny";
  expect(greeting).toBe("bunny");
});
