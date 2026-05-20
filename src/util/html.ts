/**
 * Strip HTML tags from a string by removing every `<...>` match until the
 * output is stable. The fixed-point loop prevents a single-pass strip from
 * leaving residue when an attacker crafts nested or overlapping tags such as
 * `<scr<script>ipt>`, which would otherwise still contain `<script` after a
 * single `replace`.
 *
 * The result is plain text — callers that subsequently inline it into HTML
 * must still escape it.
 */
export function stripHtmlTags(input: string): string {
  let prev: string;
  let next = input;
  // Bound the loop defensively so a pathological input cannot wedge a worker;
  // each iteration must strictly shrink the string, so 32 passes is plenty.
  for (let i = 0; i < 32; i++) {
    prev = next;
    next = prev.replace(/<[^>]*>/g, "");
    if (next === prev) break;
  }
  return next;
}
