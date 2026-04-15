/**
 * Normalise a numeric override input. Blank → `null` (caller inherits the
 * upstream default). Non-negative integer → number. Anything else (negative,
 * non-integer, non-numeric) → `undefined` so the caller can surface a
 * validation error.
 */
export function validateOverride(raw: string): number | null | undefined {
  const t = raw.trim();
  if (t === "") return null;
  const n = Number(t);
  if (!Number.isInteger(n) || n < 0) return undefined;
  return n;
}
