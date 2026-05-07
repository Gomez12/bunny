/**
 * groupTurns sets isError=true for assistant rows with channel="error".
 * Regression: before this fix, error messages from the secret guard were
 * stored as channel="content" and rendered without error styling on reload.
 */

import { describe, expect, test } from "bun:test";
import { groupTurns, type StoredMessage } from "../../web/src/api.ts";

function msg(overrides: Partial<StoredMessage>): StoredMessage {
  return {
    id: 1,
    sessionId: "s1",
    ts: 1000,
    role: "assistant",
    channel: "content",
    content: null,
    toolCallId: null,
    toolName: null,
    providerSig: null,
    ok: null,
    durationMs: null,
    promptTokens: null,
    completionTokens: null,
    userId: null,
    username: null,
    displayName: null,
    project: "general",
    author: null,
    attachments: null,
    editedAt: null,
    regenOfMessageId: null,
    regenChain: [],
    ...overrides,
  };
}

describe("groupTurns error channel", () => {
  test("isError=false for normal content rows", () => {
    const msgs: StoredMessage[] = [
      msg({ id: 1, role: "user", channel: "content", content: "hello" }),
      msg({ id: 2, role: "assistant", channel: "content", content: "world", regenChain: [{ id: 2, ts: 1000, content: "world" }] }),
    ];
    const turns = groupTurns(msgs);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.isError).toBe(false);
    expect(turns[0]!.content).toBe("world");
  });

  test("isError=true for channel='error' rows", () => {
    const errorMsg = "Your message contains a value that is marked as forbidden for LLM use.";
    const msgs: StoredMessage[] = [
      msg({ id: 1, role: "user", channel: "content", content: "secret123" }),
      msg({ id: 2, role: "assistant", channel: "error", content: errorMsg, author: "bunny" }),
    ];
    const turns = groupTurns(msgs);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.isError).toBe(true);
    expect(turns[0]!.content).toBe(errorMsg);
    expect(turns[0]!.contentMessageId).toBe(2);
    expect(turns[0]!.author).toBe("bunny");
  });

  test("error channel row sets contentMessageId for edit/regen actions", () => {
    const msgs: StoredMessage[] = [
      msg({ id: 10, role: "user", channel: "content", content: "bad prompt" }),
      msg({ id: 11, role: "assistant", channel: "error", content: "blocked" }),
    ];
    const turns = groupTurns(msgs);
    expect(turns[0]!.contentMessageId).toBe(11);
  });
});
