/**
 * Shared Telegram helpers used across client, handler, outbound, and routes.
 */

/** Last 4 chars of a bot token, for queue-log data. Never logs the full token. */
export function tokenTail(token: string): string {
  return token.length <= 4 ? token : token.slice(-4);
}

const HTML_ENT: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
};

const HTML_ATTR_ENT: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

/** Escape `&`, `<`, `>` for Telegram `parse_mode=HTML`. Quotes stay literal —
 *  Telegram only treats the three as structural. */
export function escapeTelegramHtml(raw: string): string {
  return raw.replace(/[&<>]/g, (c) => HTML_ENT[c] ?? c);
}

/** Escape for use inside an HTML attribute value (e.g. `href="..."`). Adds
 *  `"` escaping on top of the structural three — without it, a hostile URL
 *  containing `"` would break out of the attribute and could inject other
 *  attributes (e.g. `onerror=`). */
export function escapeTelegramHtmlAttr(raw: string): string {
  return raw.replace(/[&<>"]/g, (c) => HTML_ATTR_ENT[c] ?? c);
}
