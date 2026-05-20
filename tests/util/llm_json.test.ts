import { describe, expect, test } from "bun:test";
import {
  extractLlmJsonCandidates,
  tryParseLlmJson,
} from "../../src/util/llm_json.ts";

describe("extractLlmJsonCandidates", () => {
  test("returns raw input when it is already JSON", () => {
    const candidates = extractLlmJsonCandidates('{"a":1}');
    expect(candidates[0]).toBe('{"a":1}');
  });

  test("extracts payload from a standard ```json fence", () => {
    const raw = 'Here you go:\n```json\n{"term":"Stoel"}\n```\nthanks!';
    const c = extractLlmJsonCandidates(raw);
    expect(c).toContain('{"term":"Stoel"}');
  });

  test("extracts payload when fence has no leading or trailing newline", () => {
    const raw = '```json{"term":"Stoel"}```';
    const c = extractLlmJsonCandidates(raw);
    expect(c).toContain('{"term":"Stoel"}');
  });

  test("extracts payload from a bare ``` fence", () => {
    const raw = '```\n{"term":"Tisch"}\n```';
    const c = extractLlmJsonCandidates(raw);
    expect(c).toContain('{"term":"Tisch"}');
  });

  test("extracts via outermost-brace fallback when no fence", () => {
    const raw = 'sure here: {"term":"Silla"} cheers';
    const c = extractLlmJsonCandidates(raw);
    expect(c).toContain('{"term":"Silla"}');
  });

  test("extracts via outermost-bracket fallback for top-level arrays", () => {
    const raw = "list: [1, 2, 3] done";
    const c = extractLlmJsonCandidates(raw);
    expect(c).toContain("[1, 2, 3]");
  });

  test("deduplicates identical candidates", () => {
    const raw = '{"a":1}';
    const c = extractLlmJsonCandidates(raw);
    expect(c.filter((s) => s === '{"a":1}')).toHaveLength(1);
  });
});

describe("tryParseLlmJson", () => {
  test("parses fenced JSON object", () => {
    const out = tryParseLlmJson<{ term: string }>('```json\n{"term":"X"}\n```');
    expect(out).toEqual({ term: "X" });
  });

  test("parses fence with no surrounding newlines (the regression case)", () => {
    const out = tryParseLlmJson<{ term: string }>('```json{"term":"Y"}```');
    expect(out).toEqual({ term: "Y" });
  });

  test("parses bare-fenced JSON array", () => {
    const out = tryParseLlmJson<number[]>("```\n[1,2,3]\n```");
    expect(out).toEqual([1, 2, 3]);
  });

  test("parses raw JSON without any fence", () => {
    const out = tryParseLlmJson<{ a: number }>('{"a":1}');
    expect(out).toEqual({ a: 1 });
  });

  test("falls back to brace-span when prose surrounds the JSON", () => {
    const out = tryParseLlmJson<{ a: number }>(
      'I think the answer is {"a":1} — hope that helps!',
    );
    expect(out).toEqual({ a: 1 });
  });

  test("skips parsed-but-invalid candidates when validator rejects them", () => {
    type News = { items: unknown[] };
    const isNews = (v: unknown): v is News =>
      !!v && typeof v === "object" && Array.isArray((v as News).items);
    const raw = 'pre {"unrelated":true} ```json\n{"items":[1,2]}\n``` post';
    const out = tryParseLlmJson<News>(raw, isNews);
    expect(out).toEqual({ items: [1, 2] });
  });

  test("returns null when nothing parses", () => {
    expect(tryParseLlmJson("just prose, no json here")).toBeNull();
  });

  test("returns null when input is empty", () => {
    expect(tryParseLlmJson("")).toBeNull();
  });
});
