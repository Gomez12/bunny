import { describe, expect, test } from "bun:test";
import { createRenderer } from "../../src/agent/render.ts";
import type { StreamDelta } from "../../src/llm/types.ts";

function makeOut() {
  const chunks: string[] = [];
  return {
    write(s: string) {
      chunks.push(s);
    },
    get text() {
      return chunks.join("");
    },
  };
}

function renderer(mode: "collapsed" | "inline" | "hidden" = "collapsed", color = false) {
  const out = makeOut();
  const r = createRenderer({ reasoningMode: mode, forceColor: color, out });
  return { r, out };
}

function delta(channel: StreamDelta["channel"], text: string): StreamDelta {
  if (channel === "content") return { channel, index: 0, text };
  if (channel === "reasoning") return { channel, index: 0, text };
  if (channel === "tool_call") return { channel, index: 0, callIndex: 0, argsDelta: text };
  return { channel: "usage", promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

describe("renderer — content", () => {
  test("emits content text directly", () => {
    const { r, out } = renderer();
    r.onDelta(delta("content", "Hello world"));
    expect(out.text).toContain("Hello world");
  });
});

describe("renderer — reasoning (collapsed)", () => {
  test("emits reasoning block header and text", () => {
    const { r, out } = renderer("collapsed", false);
    r.onDelta(delta("reasoning", "Let me think"));
    expect(out.text).toContain("[thinking]");
    expect(out.text).toContain("Let me think");
  });

  test("closes reasoning block when content starts", () => {
    const { r, out } = renderer("collapsed", false);
    r.onDelta(delta("reasoning", "thinking..."));
    r.onDelta(delta("content", "answer"));
    expect(out.text).toContain("[/thinking]");
    expect(out.text).toContain("answer");
  });

  test("does not open block twice", () => {
    const { r, out } = renderer("collapsed", false);
    r.onDelta(delta("reasoning", "a"));
    r.onDelta(delta("reasoning", "b"));
    const opens = (out.text.match(/\[thinking\]/g) ?? []).length;
    expect(opens).toBe(1);
  });
});

describe("renderer — reasoning (hidden)", () => {
  test("hides reasoning text", () => {
    const { r, out } = renderer("hidden");
    r.onDelta(delta("reasoning", "secret thoughts"));
    r.onDelta(delta("content", "public answer"));
    expect(out.text).not.toContain("secret thoughts");
    expect(out.text).toContain("public answer");
  });
});

describe("renderer — reasoning (inline)", () => {
  test("shows reasoning inline with header but no closing box", () => {
    const { r, out } = renderer("inline", false);
    r.onDelta(delta("reasoning", "thinking inline"));
    expect(out.text).toContain("[thinking]");
    expect(out.text).toContain("thinking inline");
    expect(out.text).not.toContain("[/thinking]");
  });
});

describe("renderer — tool_call", () => {
  test("emits tool name and args", () => {
    const { r, out } = renderer();
    r.onDelta({ channel: "tool_call", index: 0, callIndex: 0, name: "read_file", argsDelta: '{"path":"x"}' });
    r.onToolResult("read_file", { ok: true, output: "content" });
    expect(out.text).toContain("read_file(");
    expect(out.text).toContain('{"path":"x"}');
  });

  test("marks tool result as error when ok=false", () => {
    const { r, out } = renderer("collapsed", false);
    r.onDelta({ channel: "tool_call", index: 0, callIndex: 0, name: "read_file", argsDelta: "" });
    r.onToolResult("read_file", { ok: false, output: "not found", error: "not found" });
    // Should contain error text (no ANSI in non-color mode, just raw)
    expect(out.text).toContain("not found");
  });
});

describe("renderer — ANSI colors", () => {
  test("dim italic applied to reasoning when color=true", () => {
    const { r, out } = renderer("collapsed", true);
    r.onDelta(delta("reasoning", "think"));
    // \x1b[2;3m = dim italic
    expect(out.text).toContain("\x1b[2;3m");
  });

  test("no ANSI when color=false", () => {
    const { r, out } = renderer("collapsed", false);
    r.onDelta(delta("content", "hello"));
    expect(out.text).not.toContain("\x1b[");
  });
});

describe("renderer — onTurnEnd", () => {
  test("closes any open reasoning block", () => {
    const { r, out } = renderer("collapsed", false);
    r.onDelta(delta("reasoning", "thinking..."));
    r.onTurnEnd();
    expect(out.text).toContain("[/thinking]");
  });
});
