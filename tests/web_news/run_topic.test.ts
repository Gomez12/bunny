import { describe, expect, test } from "bun:test";
import { extractNewsJson } from "../../src/web_news/run_topic.ts";

describe("extractNewsJson", () => {
  test("parses a fenced json block with items", () => {
    const raw = [
      "Here is the JSON:",
      "```json",
      JSON.stringify({
        items: [
          {
            title: "Story A",
            summary: "Plain summary",
            url: "https://example.com/a",
            imageUrl: null,
            source: "Example",
            publishedAt: "2026-04-18T10:00:00Z",
          },
        ],
      }),
      "```",
    ].join("\n");

    const parsed = extractNewsJson(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.items).toHaveLength(1);
    expect(parsed!.items[0]!.title).toBe("Story A");
    expect(parsed!.items[0]!.url).toBe("https://example.com/a");
    expect(parsed!.items[0]!.publishedAt).not.toBeNull();
    expect(parsed!.improvedTerms).toBeNull();
  });

  test("parses a bare fenced block as a fallback", () => {
    const raw = [
      "```",
      JSON.stringify({ items: [{ title: "Hello" }] }),
      "```",
    ].join("\n");
    const parsed = extractNewsJson(raw);
    expect(parsed!.items[0]!.title).toBe("Hello");
  });

  test("parses improvedTerms when present", () => {
    const raw = [
      "```json",
      JSON.stringify({
        improvedTerms: ["term one", "term two", ""],
        items: [{ title: "x" }],
      }),
      "```",
    ].join("\n");
    const parsed = extractNewsJson(raw);
    expect(parsed!.improvedTerms).toEqual(["term one", "term two"]);
  });

  test("rejects invalid URLs and keeps the item", () => {
    const raw = [
      "```json",
      JSON.stringify({
        items: [
          { title: "ok", url: "javascript:alert(1)", imageUrl: "ftp://x" },
        ],
      }),
      "```",
    ].join("\n");
    const parsed = extractNewsJson(raw);
    expect(parsed!.items).toHaveLength(1);
    expect(parsed!.items[0]!.url).toBeNull();
    expect(parsed!.items[0]!.imageUrl).toBeNull();
  });

  test("returns null on garbage", () => {
    expect(extractNewsJson("not even json")).toBeNull();
    expect(extractNewsJson("")).toBeNull();
  });

  test("skips items without a title", () => {
    const raw = [
      "```json",
      JSON.stringify({ items: [{ summary: "no title" }, { title: "yes" }] }),
      "```",
    ].join("\n");
    const parsed = extractNewsJson(raw);
    expect(parsed!.items).toHaveLength(1);
    expect(parsed!.items[0]!.title).toBe("yes");
  });
});
