/**
 * Lenient JSON extraction for LLM responses.
 *
 * Modern instruct-tuned models are inconsistent about structured output:
 * they may wrap the payload in a ```json fence, a bare ``` fence, return
 * raw JSON, or bury it inside a prose preamble ("Sure! Here is the JSON:").
 * Every "give-me-back-JSON" caller used to ship its own candidate-list +
 * `JSON.parse` loop with a strict `/```json\s*\n([\s\S]*?)\n```/` regex —
 * which silently drops the payload whenever the model omits a newline.
 *
 * This module is the single source of truth. Callers either ask for the
 * ordered candidate list (so they can layer schema validation per-shape)
 * or use `tryParseLlmJson` for a one-shot lenient parse.
 */

const FENCED_JSON_RE = /```(?:json|JSON)\s*([\s\S]*?)```/;
const FENCED_BARE_RE = /```\s*([\s\S]*?)```/;

/**
 * Ordered list of JSON candidate strings to try parsing, in descending
 * preference: (1) raw trimmed input, (2) ```json``` fenced block,
 * (3) bare ``` fenced block, (4) outermost `{...}` span, (5) outermost
 * `[...]` span. Duplicates are collapsed so callers don't `JSON.parse`
 * the same string twice.
 *
 * The fence regexes accept any whitespace (including missing newlines)
 * between the opener / closer and the payload — modern small models often
 * emit ```json{...}``` on a single line, which the old strict regex missed.
 */
export function extractLlmJsonCandidates(raw: string): string[] {
  const candidates: string[] = [];
  const trimmed = raw.trim();
  if (trimmed) candidates.push(trimmed);

  const fencedJson = raw.match(FENCED_JSON_RE);
  if (fencedJson?.[1]) candidates.push(fencedJson[1].trim());

  const fencedBare = raw.match(FENCED_BARE_RE);
  if (fencedBare?.[1]) candidates.push(fencedBare[1].trim());

  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(raw.slice(firstBrace, lastBrace + 1));
  }

  const firstBracket = raw.indexOf("[");
  const lastBracket = raw.lastIndexOf("]");
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    candidates.push(raw.slice(firstBracket, lastBracket + 1));
  }

  return Array.from(new Set(candidates.filter((c) => c.length > 0)));
}

/**
 * Walk the candidate list and return the first that parses as JSON. When
 * `validate` is supplied, candidates that parse but don't satisfy the
 * predicate are skipped — letting the caller hold out for a payload that
 * matches the expected schema instead of accepting the first stray `{}`
 * the model happened to mention in its prose.
 */
export function tryParseLlmJson<T = unknown>(
  raw: string,
  validate?: (value: unknown) => value is T,
): T | null {
  for (const candidate of extractLlmJsonCandidates(raw)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!validate || validate(parsed)) return parsed as T;
  }
  return null;
}
