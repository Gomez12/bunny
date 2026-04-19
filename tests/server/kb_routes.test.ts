import { describe, expect, test } from "bun:test";
import {
  extractDefinitionJson,
  extractSvgBlock,
} from "../../src/server/kb_routes.ts";

describe("extractDefinitionJson", () => {
  test("parses a ```json fence", () => {
    const raw = [
      "Sure, here you go:",
      "",
      "```json",
      JSON.stringify({
        shortDescription: "A piece of seating furniture.",
        longDescription: "The long one.",
        sources: [
          { title: "Wikipedia", url: "https://en.wikipedia.org/wiki/Chair" },
        ],
      }),
      "```",
    ].join("\n");
    const parsed = extractDefinitionJson(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.short).toBe("A piece of seating furniture.");
    expect(parsed!.long).toBe("The long one.");
    expect(parsed!.sources).toEqual([
      { title: "Wikipedia", url: "https://en.wikipedia.org/wiki/Chair" },
    ]);
  });

  test("falls back to bare fence", () => {
    const raw =
      "```\n" +
      JSON.stringify({
        shortDescription: "s",
        longDescription: "l",
        sources: [],
      }) +
      "\n```";
    const parsed = extractDefinitionJson(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.short).toBe("s");
    expect(parsed!.long).toBe("l");
  });

  test("falls back to raw JSON object scan", () => {
    const raw =
      'Here is the definition: {"shortDescription":"s","longDescription":"l","sources":[]} done';
    const parsed = extractDefinitionJson(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.short).toBe("s");
  });

  test("drops sources with invalid URLs", () => {
    const raw =
      "```json\n" +
      JSON.stringify({
        shortDescription: "s",
        longDescription: "l",
        sources: [
          { title: "bad", url: "javascript:alert(1)" },
          { title: "ok", url: "https://example.com" },
        ],
      }) +
      "\n```";
    const parsed = extractDefinitionJson(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.sources).toEqual([
      { title: "ok", url: "https://example.com" },
    ]);
  });

  test("returns null when no JSON present", () => {
    expect(
      extractDefinitionJson("Sorry, I could not find anything."),
    ).toBeNull();
  });

  test("returns null when JSON has no meaningful fields", () => {
    const raw = "```json\n{}\n```";
    expect(extractDefinitionJson(raw)).toBeNull();
  });
});

describe("extractSvgBlock", () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';

  test("parses a ```svg fence", () => {
    const raw = `Here you go:\n\n\`\`\`svg\n${svg}\n\`\`\``;
    const parsed = extractSvgBlock(raw);
    expect(parsed).not.toBeNull();
    expect(parsed).toContain("<svg");
    expect(parsed).toContain("</svg>");
  });

  test("falls back to a bare ``` fence", () => {
    const raw = `\`\`\`\n${svg}\n\`\`\``;
    const parsed = extractSvgBlock(raw);
    expect(parsed).toBe(svg);
  });

  test("falls back to a raw <svg>…</svg> match", () => {
    const raw = `Sure, here is your illustration: ${svg} — hope it helps!`;
    const parsed = extractSvgBlock(raw);
    expect(parsed).toBe(svg);
  });

  test("rejects payloads that don't contain an <svg> element", () => {
    expect(extractSvgBlock("Sorry, I could not draw that.")).toBeNull();
    expect(extractSvgBlock("```\nhello world\n```")).toBeNull();
  });

  test("rejects payloads exceeding the size cap", () => {
    const huge = `<svg xmlns="http://www.w3.org/2000/svg">${"a".repeat(
      300 * 1024,
    )}</svg>`;
    expect(extractSvgBlock(huge)).toBeNull();
  });
});
