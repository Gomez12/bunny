import { describe, expect, test } from "bun:test";
import type { SseSink } from "../../src/agent/render_sse.ts";
import {
  closeAllFor,
  hasFanout,
  publish,
  subscriberCount,
  subscribeUser,
} from "../../src/notifications/fanout.ts";

function mockSink(): SseSink & { chunks: string[]; closed: boolean } {
  const chunks: string[] = [];
  const state = {
    chunks,
    closed: false,
    enqueue(chunk: Uint8Array) {
      chunks.push(new TextDecoder().decode(chunk));
    },
    close() {
      state.closed = true;
    },
  };
  return state;
}

describe("subscribeUser", () => {
  test("delivers published events to one subscriber", () => {
    const sink = mockSink();
    const unsub = subscribeUser("alice", sink);
    try {
      publish("alice", {
        type: "notification_read",
        ids: [7],
        readAt: 123,
      });
      expect(sink.chunks).toHaveLength(1);
      const line = sink.chunks[0]!;
      expect(line.startsWith("data: ")).toBe(true);
      const payload = JSON.parse(line.slice(6).trim());
      expect(payload).toEqual({
        type: "notification_read",
        ids: [7],
        readAt: 123,
      });
    } finally {
      unsub();
    }
  });

  test("broadcasts to every subscriber (multi-tab)", () => {
    const s1 = mockSink();
    const s2 = mockSink();
    const u1 = subscribeUser("alice", s1);
    const u2 = subscribeUser("alice", s2);
    try {
      publish("alice", {
        type: "notification_read",
        ids: [1],
        readAt: 1,
      });
      expect(s1.chunks).toHaveLength(1);
      expect(s2.chunks).toHaveLength(1);
    } finally {
      u1();
      u2();
    }
  });

  test("unsubscribe stops further events, drops map when last leaves", () => {
    const s1 = mockSink();
    const s2 = mockSink();
    const u1 = subscribeUser("carol", s1);
    const u2 = subscribeUser("carol", s2);
    expect(subscriberCount("carol")).toBe(2);
    u1();
    expect(subscriberCount("carol")).toBe(1);
    publish("carol", { type: "notification_read", ids: [], readAt: 1 });
    expect(s1.chunks).toHaveLength(0);
    expect(s2.chunks).toHaveLength(1);
    u2();
    expect(hasFanout("carol")).toBe(false);
  });

  test("publish without subscribers is a no-op", () => {
    // No throw, no state change.
    publish("nobody_home", { type: "notification_read", ids: [], readAt: 1 });
    expect(hasFanout("nobody_home")).toBe(false);
  });

  test("events for other users don't leak", () => {
    const bobSink = mockSink();
    const u = subscribeUser("bob", bobSink);
    try {
      publish("alice", { type: "notification_read", ids: [], readAt: 1 });
      expect(bobSink.chunks).toHaveLength(0);
    } finally {
      u();
    }
  });
});

describe("closeAllFor", () => {
  test("closes every sink and clears the map entry", () => {
    const s1 = mockSink();
    const s2 = mockSink();
    subscribeUser("dave", s1);
    subscribeUser("dave", s2);
    expect(subscriberCount("dave")).toBe(2);
    closeAllFor("dave");
    expect(s1.closed).toBe(true);
    expect(s2.closed).toBe(true);
    expect(hasFanout("dave")).toBe(false);
  });

  test("closing a user with no fanout is a no-op", () => {
    // Should not throw.
    closeAllFor("ghost");
    expect(hasFanout("ghost")).toBe(false);
  });
});
