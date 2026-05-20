/**
 * Unit tests for `src/util/error.ts`.
 *
 * Covers the `SafeError` typed marker, the response-safe
 * `errorMessage()`, the diagnostic `errorDetails()`, the
 * `errorStatus()` mapper, and the queue-backed
 * `logUnexpectedError()` helper.
 *
 * The masking behaviour for non-`SafeError` instances is the security
 * barrier that closes CodeQL alert `js/stack-trace-exposure` (#13).
 */

import { describe, expect, it } from "bun:test";
import {
  errorDetails,
  errorMessage,
  errorStatus,
  INTERNAL_ERROR_MESSAGE,
  logUnexpectedError,
  SafeError,
  type LogCapableQueue,
} from "../../src/util/error.ts";

describe("SafeError", () => {
  it("exposes its safe message unchanged", () => {
    const e = new SafeError("missing project");
    expect(e.safeMessage).toBe("missing project");
    expect(e.message).toBe("missing project");
    expect(e.name).toBe("SafeError");
  });

  it("carries an httpStatus when constructed with one", () => {
    const e = new SafeError("forbidden", { httpStatus: 403 });
    expect(e.httpStatus).toBe(403);
  });

  it("leaves httpStatus undefined by default", () => {
    const e = new SafeError("missing project");
    expect(e.httpStatus).toBeUndefined();
  });

  it("forwards a cause through the standard Error options bag", () => {
    const root = new Error("db boom");
    const e = new SafeError("could not save", { cause: root });
    // Node's Error.cause is unknown-typed; assert via reference equality.
    expect((e as Error & { cause?: unknown }).cause).toBe(root);
  });
});

describe("errorMessage", () => {
  it("returns the safeMessage of a SafeError", () => {
    expect(errorMessage(new SafeError("missing project"))).toBe(
      "missing project",
    );
  });

  it("trims multi-line SafeError messages to the first line", () => {
    expect(errorMessage(new SafeError("missing project\nstack frame…"))).toBe(
      "missing project",
    );
  });

  it("returns INTERNAL_ERROR_MESSAGE for any unknown Error subclass", () => {
    expect(errorMessage(new Error("leaked internals"))).toBe(
      INTERNAL_ERROR_MESSAGE,
    );
    expect(errorMessage(new TypeError("undefined.x"))).toBe(
      INTERNAL_ERROR_MESSAGE,
    );
    expect(errorMessage(new RangeError("nope"))).toBe(INTERNAL_ERROR_MESSAGE);
  });

  it("never leaks an Error.message that contains a stack-trace fragment", () => {
    const e = new Error(
      "TypeError: cannot read property 'x' of undefined\n    at /usr/bunny/src/foo.ts:42:7",
    );
    expect(errorMessage(e)).toBe(INTERNAL_ERROR_MESSAGE);
  });

  it("returns a first-line, capped string for non-Error thrown values", () => {
    expect(errorMessage("string thrown")).toBe("string thrown");
    expect(errorMessage("two\nlines")).toBe("two");
    expect(errorMessage("x".repeat(500)).length).toBe(200);
  });

  it("stringifies null and undefined to stable diagnostic values", () => {
    expect(errorMessage(null)).toBe("null");
    expect(errorMessage(undefined)).toBe("undefined");
  });
});

describe("errorDetails", () => {
  it("returns the raw first line of an Error.message", () => {
    expect(
      errorDetails(new Error("git clone failed: connection refused")),
    ).toBe("git clone failed: connection refused");
  });

  it("strips a leading class-name prefix", () => {
    const e = new Error("boom");
    e.message = "TypeError: cannot read property 'x'";
    expect(errorDetails(e)).toBe("cannot read property 'x'");
  });

  it("caps to 200 characters", () => {
    expect(errorDetails(new Error("x".repeat(500))).length).toBe(200);
  });

  it("falls back to String(e) for non-Error values", () => {
    expect(errorDetails(42)).toBe("42");
    expect(errorDetails(null)).toBe("null");
  });
});

describe("errorStatus", () => {
  it("returns the SafeError httpStatus when present", () => {
    expect(errorStatus(new SafeError("forbidden", { httpStatus: 403 }))).toBe(
      403,
    );
  });

  it("returns the fallback for SafeError without httpStatus", () => {
    expect(errorStatus(new SafeError("oops"))).toBe(500);
    expect(errorStatus(new SafeError("oops"), 400)).toBe(400);
  });

  it("returns the fallback for plain Errors", () => {
    expect(errorStatus(new Error("boom"))).toBe(500);
    expect(errorStatus(new Error("boom"), 400)).toBe(400);
  });
});

describe("logUnexpectedError", () => {
  function makeQueue(): {
    queue: LogCapableQueue;
    calls: Parameters<LogCapableQueue["log"]>[0][];
  } {
    const calls: Parameters<LogCapableQueue["log"]>[0][] = [];
    return {
      calls,
      queue: {
        async log(payload) {
          calls.push(payload);
        },
      },
    };
  }

  it("forwards the diagnostic details for unknown Errors", () => {
    const { queue, calls } = makeQueue();
    logUnexpectedError(queue, new Error("db boom"), "POST /api/foo");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.topic).toBe("error");
    expect(calls[0]?.kind).toBe("unexpected");
    expect(calls[0]?.error).toBe("db boom");
    expect(calls[0]?.data).toEqual({ context: "POST /api/foo" });
  });

  it("does not log SafeError instances", () => {
    const { queue, calls } = makeQueue();
    logUnexpectedError(queue, new SafeError("missing X"), "ctx");
    expect(calls).toHaveLength(0);
  });

  it("is a no-op when the queue is undefined", () => {
    expect(() =>
      logUnexpectedError(undefined, new Error("boom"), "ctx"),
    ).not.toThrow();
  });
});
