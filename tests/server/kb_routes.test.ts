import { describe, expect, test } from "bun:test";
import {
  buildDefinitionPrompt,
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

describe("buildDefinitionPrompt", () => {
  const base = {
    projectName: "demo",
    projectContext: "demo",
    term: "EN 342",
    manualDescription: "",
    isProjectDependent: false,
    targetLang: "nl",
  };

  test("includes the explicit ISO 639-1 language directive", () => {
    const out = buildDefinitionPrompt(base);
    expect(out).toContain(
      `Target language for shortDescription and longDescription: "nl" (ISO 639-1).`,
    );
    expect(out).toContain("Write both fields entirely in this language.");
  });

  test("includes a labelled manual description when non-empty", () => {
    const out = buildDefinitionPrompt({
      ...base,
      manualDescription:
        "  Beschermende kleding tegen koude omgevingen volgens norm.  ",
    });
    expect(out).toContain(
      "Manual description (authored by the user, in the target language):",
    );
    expect(out).toContain(
      "Beschermende kleding tegen koude omgevingen volgens norm.",
    );
  });

  test("omits the manual description when empty or whitespace-only", () => {
    const out = buildDefinitionPrompt({ ...base, manualDescription: "   " });
    expect(out).not.toContain("Manual description");
  });

  test("truncates an overly long manual description", () => {
    const long = "x".repeat(5000);
    const out = buildDefinitionPrompt({ ...base, manualDescription: long });
    expect(out).toContain("…");
    expect(out.length).toBeLessThan(5000);
  });

  test("includes the project-context preamble only when isProjectDependent", () => {
    const without = buildDefinitionPrompt(base);
    expect(without).not.toContain("Project context:");
    expect(without).toContain('Define the term: "EN 342"');

    const withCtx = buildDefinitionPrompt({
      ...base,
      isProjectDependent: true,
      projectContext: "industrial cold-weather workwear",
    });
    expect(withCtx).toContain("Project: demo");
    expect(withCtx).toContain(
      "Project context: industrial cold-weather workwear",
    );
    expect(withCtx).toContain(
      'Define the term (blend with project context when forming search queries): "EN 342"',
    );
  });
});
