import { describe, expect, test } from "bun:test";
import { createSseRenderer, type SseSink } from "../../src/agent/render_sse.ts";
import type { StreamDelta } from "../../src/llm/types.ts";

function collectingSink() {
  const chunks: string[] = [];
  let closed = false;
  const sink: SseSink = {
    enqueue(u8) {
      chunks.push(new TextDecoder().decode(u8));
    },
    close() {
      closed = true;
    },
  };
  return {
    sink,
    get raw() {
      return chunks.join("");
    },
    get events() {
      return chunks
        .join("")
        .split("\n\n")
        .filter((f) => f.startsWith("data:"))
        .map((f) => JSON.parse(f.slice(5).trim()) as Record<string, unknown>);
    },
    get closed() {
      return closed;
    },
  };
}

describe("SSE renderer", () => {
  test("emits content deltas as JSON events", () => {
    const s = collectingSink();
    const r = createSseRenderer(s.sink);
    r.onDelta({
      channel: "content",
      index: 0,
      text: "hello",
    } satisfies StreamDelta);
    expect(s.events).toEqual([{ type: "content", text: "hello" }]);
  });

  test("emits reasoning deltas", () => {
    const s = collectingSink();
    const r = createSseRenderer(s.sink);
    r.onDelta({ channel: "reasoning", index: 0, text: "thinking" });
    expect(s.events[0]).toEqual({ type: "reasoning", text: "thinking" });
  });

  test("emits tool_call with name and argsDelta", () => {
    const s = collectingSink();
    const r = createSseRenderer(s.sink);
    r.onDelta({
      channel: "tool_call",
      index: 0,
      callIndex: 0,
      name: "read",
      argsDelta: '{"p":',
    });
    expect(s.events[0]).toMatchObject({
      type: "tool_call",
      name: "read",
      argsDelta: '{"p":',
    });
  });

  test("emits tool_result with ok/error", () => {
    const s = collectingSink();
    const r = createSseRenderer(s.sink);
    r.onToolResult("read", { ok: false, output: "no", error: "nope" });
    expect(s.events[0]).toEqual({
      type: "tool_result",
      name: "read",
      ok: false,
      output: "no",
      error: "nope",
    });
  });

  test("emits error and turn_end events", () => {
    const s = collectingSink();
    const r = createSseRenderer(s.sink);
    r.onError("boom");
    r.onTurnEnd();
    expect(s.events).toEqual([
      { type: "error", message: "boom" },
      { type: "turn_end" },
    ]);
  });

  test("frames each payload as a single SSE data line", () => {
    const s = collectingSink();
    const r = createSseRenderer(s.sink);
    r.onDelta({ channel: "content", index: 0, text: "a" });
    r.onDelta({ channel: "content", index: 0, text: "b" });
    const frames = s.raw.split("\n\n").filter(Boolean);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatch(/^data: /);
  });

  test("swallows errors when controller already closed (via controllerSink)", async () => {
    // Simulate a closed controller by creating one and cancelling immediately.
    const { controllerSink } = await import("../../src/agent/render_sse.ts");
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    const sink = controllerSink(controller);
    await stream.cancel();
    // Should not throw.
    sink.enqueue(new TextEncoder().encode("data: x\n\n"));
    sink.close();
    expect(true).toBe(true);
  });
});
