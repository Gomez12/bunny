import { afterEach, describe, expect, test } from "bun:test";

import { makeAskUserTool } from "../../src/tools/ask_user.ts";
import type { SseAskUserQuestionEvent } from "../../src/agent/sse_events.ts";
import {
  __pendingCountForTests,
  __resetPendingQuestionsForTests,
  answerPendingQuestion,
  cancelPendingQuestion,
} from "../../src/agent/ask_user_registry.ts";

afterEach(() => __resetPendingQuestionsForTests());

function makeTool(sessionId: string, opts: { id?: string } = {}) {
  const emitted: SseAskUserQuestionEvent[] = [];
  const tool = makeAskUserTool({
    sessionId,
    emit: (ev) => emitted.push(ev),
    newId: () => opts.id ?? "qid-1",
    timeoutMs: 1_000,
  });
  return { tool, emitted };
}

describe("ask_user tool", () => {
  test("emits a question and resolves with the user's answer", async () => {
    const { tool, emitted } = makeTool("s1");
    const pending = tool.handler({
      question: "Which lunch?",
      options: ["Burger", "Salad"],
    });
    // Give the handler a microtask tick to register the waiter.
    await Promise.resolve();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.questionId).toBe("qid-1");
    expect(emitted[0]!.options).toEqual(["Burger", "Salad"]);
    expect(emitted[0]!.allowCustom).toBe(true);
    expect(emitted[0]!.multiSelect).toBe(false);
    expect(__pendingCountForTests()).toBe(1);

    expect(answerPendingQuestion("s1", "qid-1", "Salad")).toBe(true);
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(result.output).toBe("Salad");
    expect(__pendingCountForTests()).toBe(0);
  });

  test("rejects empty question", async () => {
    const { tool } = makeTool("s1");
    const result = await tool.handler({ question: "   " });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/question/i);
  });

  test("rejects when options are empty and allow_custom=false", async () => {
    const { tool } = makeTool("s1");
    const result = await tool.handler({
      question: "Pick",
      options: [],
      allow_custom: false,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/at least one option/);
  });

  test("times out when no answer arrives", async () => {
    const tool = makeAskUserTool({
      sessionId: "s1",
      emit: () => {},
      newId: () => "qid-timeout",
      timeoutMs: 30,
    });
    const result = await tool.handler({
      question: "Still there?",
      allow_custom: true,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timed out/);
  });

  test("caps options at 24 and drops empty entries", async () => {
    const { tool, emitted } = makeTool("s1");
    const surplus = Array.from({ length: 30 }, (_, i) => `O${i + 1}`);
    const pending = tool.handler({
      question: "Pick one",
      options: ["", ...surplus, "   "],
    });
    await Promise.resolve();
    expect(emitted[0]!.options).toHaveLength(24);
    expect(emitted[0]!.options[0]).toBe("O1");
    expect(emitted[0]!.options[23]).toBe("O24");
    cancelPendingQuestion("s1", "qid-1");
    const result = await pending;
    expect(result.ok).toBe(false);
  });

  test("answerPendingQuestion returns false for unknown question", () => {
    expect(answerPendingQuestion("s1", "missing", "x")).toBe(false);
  });
});
