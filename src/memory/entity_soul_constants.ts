/**
 * Constants shared across the per-entity soul subsystem (ADR 0036).
 *
 * Contacts and businesses both carry an LLM-curated "soul" body — a short,
 * periodically-refreshed summary of what the person/organisation is currently
 * up to, derived from their public socials + website via web tools.
 *
 * Kept separate from `MEMORY_FIELD_CHAR_LIMIT` (user/agent memory) so future
 * tuning of the entity-soul cap doesn't drag user-memory along with it.
 */

/** Hard cap (in UTF-16 code units) for any contact/business soul body. */
export const ENTITY_SOUL_CHAR_LIMIT = 4000;

/** Default cadence between auto-refreshes for an entity soul (24 h). */
export const ENTITY_SOUL_DEFAULT_CADENCE_MS = 24 * 60 * 60 * 1000;

/** Truncate to the cap. Auto-refresh callers store the LLM output via this. */
export function clampSoul(text: string): string {
  if (text.length <= ENTITY_SOUL_CHAR_LIMIT) return text;
  return text.slice(0, ENTITY_SOUL_CHAR_LIMIT);
}

/**
 * Walk the candidate JSON payloads embedded in a model response, in the
 * order: `\`\`\`json\`\`\`` fence → bare `\`\`\`` fence → first/last brace
 * span. Each candidate is JSON-parsed; the first that succeeds and yields
 * a plain object is returned. Used by every "give me back JSON" handler in
 * the codebase (KB definition generate, soul refresh, auto-build enrich) so
 * the parsing-tolerance contract stays uniform.
 */
export function extractFencedJson(raw: string): Record<string, unknown> | null {
  const candidates: string[] = [];
  const fencedJson = raw.match(/```json\s*\n([\s\S]*?)\n```/);
  if (fencedJson?.[1]) candidates.push(fencedJson[1]);
  const fencedBare = raw.match(/```\s*\n([\s\S]*?)\n```/);
  if (fencedBare?.[1]) candidates.push(fencedBare[1]);
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(raw.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates) {
    try {
      const obj = JSON.parse(candidate.trim());
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        return obj as Record<string, unknown>;
      }
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Parse the JSON contract emitted by `contact.soul.refresh` and
 * `business.soul.refresh`. Returns null when no candidate yields a non-empty
 * `soul` and at least zero `sources` — the caller flips the row to `'error'`
 * so the next tick can retry instead of leaving it `'refreshing'`.
 *
 * Business-specific fields (e.g. `address`) live on the raw object the
 * caller can pull via `(parsed.raw as { address?: unknown }).address` —
 * keeping this helper ignorant of per-entity schema.
 */
export function extractSoulJson(
  raw: string,
): { soul: string; sources: string[]; raw: Record<string, unknown> } | null {
  const obj = extractFencedJson(raw);
  if (!obj) return null;
  const rawSoul = obj["soul"];
  const soul = typeof rawSoul === "string" ? rawSoul.trim() : "";
  const sources: string[] = [];
  const rawSources = obj["sources"];
  if (Array.isArray(rawSources)) {
    for (const s of rawSources) {
      if (typeof s === "string" && /^https?:\/\//i.test(s.trim())) {
        sources.push(s.trim());
        if (sources.length >= 12) break;
      }
    }
  }
  if (!soul && sources.length === 0) return null;
  return { soul, sources, raw: obj };
}
