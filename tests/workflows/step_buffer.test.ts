/**
 * Unit tests for the NodeStepBuffer. Focuses on the shape of the timeline
 * that the engine persists to `workflow_run_nodes.steps_json`.
 */

import { describe, expect, test } from "bun:test";
import { NodeStepBuffer } from "../../src/workflows/node_step_buffer.ts";

describe("NodeStepBuffer", () => {
  test("accumulates contiguous text deltas into one step", () => {
    const b = new NodeStepBuffer();
    b.onText("content", "Hel");
    b.onText("content", "lo ");
    b.onText("content", "world");
    const steps = b.finalize();
    expect(steps).toHaveLength(1);
    expect(steps[0]!.kind).toBe("text");
    expect(steps[0]!.label).toBe("content");
    expect(steps[0]!.output).toBe("Hello world");
  });

  test("splits text and reasoning into separate steps", () => {
    const b = new NodeStepBuffer();
    b.onText("content", "thinking…");
    b.onText("reasoning", "let me consider");
    b.onText("content", "back to output");
    const steps = b.finalize();
    expect(steps.map((s) => s.label)).toEqual([
      "content",
      "reasoning",
      "content",
    ]);
  });

  test("tool_call deltas + tool_result produce one tool step", () => {
    const b = new NodeStepBuffer();
    b.onText("content", "let me look");
    b.onToolCallDelta(0, "web_search", '{"query":"bunny"}');
    b.onToolResult("web_search", true, '{"results":[]}', undefined);
    b.onText("content", "done.");
    const steps = b.finalize();
    expect(steps.map((s) => s.kind)).toEqual(["text", "tool", "text"]);
    expect(steps[1]!.label).toBe("web_search");
    expect(steps[1]!.ok).toBe(true);
    expect(steps[1]!.output).toBe('{"results":[]}');
    expect(steps[1]!.summary).toContain("bunny");
  });

  test("captures errored tool results", () => {
    const b = new NodeStepBuffer();
    b.onToolCallDelta(0, "bash", '{"cmd":"exit 1"}');
    b.onToolResult("bash", false, "", "exited with code 1");
    const steps = b.finalize();
    expect(steps[0]!.ok).toBe(false);
    expect(steps[0]!.error).toBe("exited with code 1");
  });

  test("pushRaw emits a bash step", () => {
    const b = new NodeStepBuffer();
    b.pushRaw({
      kind: "bash",
      label: "bash",
      summary: "bun run validate",
      output: "ok\n",
      ok: true,
      startedAt: Date.now(),
      durationMs: 42,
    });
    expect(b.steps[0]!.kind).toBe("bash");
  });

  test("asLogText round-trips through tool + text steps", () => {
    const b = new NodeStepBuffer();
    b.onText("content", "hello ");
    b.onToolCallDelta(0, "x", "{}");
    b.onToolResult("x", true, "OUTPUT", undefined);
    b.onText("content", "done");
    b.finalize();
    const txt = b.asLogText();
    expect(txt).toContain("hello ");
    expect(txt).toContain("[tool:x] ok: OUTPUT");
    expect(txt).toContain("done");
  });
});
