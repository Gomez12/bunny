/**
 * Build an `<img>`-compatible data URL for an SVG document. Serving SVG
 * through an `<img>` tag isolates it from the page's JS context so any stray
 * `<script>` or event handler attributes in model output cannot execute.
 *
 * The data URL omits `;charset=…` / `;utf8`: UTF-8 is the default for text
 * MIME types in data URLs, and bare `;utf8,` tokens are technically malformed
 * under RFC 2397's `name=value` grammar (Safari has historically been strict).
 */
export function svgToDataUrl(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
