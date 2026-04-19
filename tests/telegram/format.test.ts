import { describe, expect, test } from "bun:test";
import {
  chunkForSend,
  decideFormat,
  markdownToTelegramHtml,
} from "../../src/telegram/format.ts";

describe("markdownToTelegramHtml", () => {
  test("escapes HTML entities in plain text", () => {
    expect(markdownToTelegramHtml("a < b & c > d")).toBe(
      "a &lt; b &amp; c &gt; d",
    );
  });

  test("converts **bold** and *italic*", () => {
    expect(markdownToTelegramHtml("**hi** and *there*")).toBe(
      "<b>hi</b> and <i>there</i>",
    );
  });

  test("preserves fenced code block content even with special chars", () => {
    const out = markdownToTelegramHtml("pre```\n<a> & <b>\n```post");
    expect(out).toContain("<pre>");
    expect(out).toContain("&lt;a&gt; &amp; &lt;b&gt;");
  });

  test("renders safe links, strips javascript: links", () => {
    const a = markdownToTelegramHtml("[ok](https://x.com)");
    expect(a).toBe('<a href="https://x.com">ok</a>');
    // Hostile scheme falls back to the link text; the anchor tag is not
    // rendered. Any leftover punctuation from an inner paren is harmless.
    const bad = markdownToTelegramHtml("[x](javascript:evil)");
    expect(bad).toBe("x");
  });

  test("handles inline code spans", () => {
    expect(markdownToTelegramHtml("use `foo` here")).toBe(
      "use <code>foo</code> here",
    );
  });

  test("degrades heading markers and list bullets", () => {
    expect(markdownToTelegramHtml("## Title\n- one\n- two")).toBe(
      "Title\n• one\n• two",
    );
  });
});

describe("chunkForSend", () => {
  test("returns the original string when under the limit", () => {
    expect(chunkForSend("short", 100)).toEqual(["short"]);
  });

  test("splits on paragraph boundaries when possible", () => {
    const text = "a".repeat(50) + "\n\n" + "b".repeat(50);
    const chunks = chunkForSend(text, 60);
    expect(chunks.length).toBe(2);
    expect(chunks[0]!).toContain("a");
    expect(chunks[1]!).toContain("b");
  });

  test("hard-splits a single oversize paragraph", () => {
    const chunks = chunkForSend("x".repeat(100), 40);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(40);
  });
});

describe("decideFormat", () => {
  test("uses html mode for short text", () => {
    const d = decideFormat("**hi**");
    expect(d.mode).toBe("html");
    expect(d.chunks[0]).toBe("<b>hi</b>");
  });

  test("prefixes chunks with (n/m) when chunking is needed", () => {
    const raw = "a".repeat(50) + "\n\n" + "b".repeat(50);
    const d = decideFormat(raw, { maxChunkChars: 60 });
    expect(d.mode).toBe("html");
    expect(d.chunks.length).toBe(2);
    expect(d.chunks[0]!.startsWith("(1/2)")).toBe(true);
    expect(d.chunks[1]!.startsWith("(2/2)")).toBe(true);
  });

  test("falls back to document mode over the byte ceiling", () => {
    const raw = "# Big\n\n" + "x".repeat(20_000);
    const d = decideFormat(raw, { documentFallbackSize: 16 * 1024 });
    expect(d.mode).toBe("document");
    expect(d.filename).toBe("bunny-reply.md");
  });
});
