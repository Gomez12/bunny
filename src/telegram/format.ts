/**
 * Markdown → Telegram-HTML subset converter + outbound chunker.
 *
 * Why HTML and not MarkdownV2: V2 requires escaping `.`, `!`, `-`, `#`, `|`,
 * `{`, `}`, `+`, `=` outside entities (and different inside), which is a
 * footgun that silently truncates messages when one slips through. HTML only
 * requires `<`, `>`, `&` to be escaped and accepts a tight subset of tags —
 * much less surprising.
 *
 * Converter supports:
 *   - `**bold**` / `__bold__` → `<b>bold</b>`
 *   - `*italic*` / `_italic_` → `<i>italic</i>`
 *   - `` `code` ``              → `<code>code</code>`
 *   - ``` ```code``` ```        → `<pre>code</pre>`
 *   - `[text](url)`            → `<a href="url">text</a>`
 *   - plain paragraphs / line breaks survive as-is
 *
 * Headings, lists, tables, blockquotes degrade to plain text prefixed with
 * hyphens/numbers — Telegram has no native support and we'd rather keep the
 * rendering readable than complete.
 */

import { escapeTelegramHtml as escapeHtml } from "./util.ts";

function renderLink(text: string, href: string): string {
  // Telegram accepts `http`, `https`, `tg://`. Reject anything else so hostile
  // model output can't produce `javascript:` links.
  if (!/^(https?|tg):\/\//i.test(href)) {
    return escapeHtml(text);
  }
  return `<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>`;
}

/**
 * Convert common markdown to Telegram-HTML. Incomplete by design — we render
 * the parts that Telegram supports and degrade the rest to plain text.
 */
export function markdownToTelegramHtml(raw: string): string {
  if (!raw) return "";

  // 1. Extract fenced code blocks first so inner markdown isn't touched.
  const preBlocks: string[] = [];
  let text = raw.replace(
    /```(?:[\w-]+)?\n?([\s\S]*?)```/g,
    (_m, code: string) => {
      const token = `\u0000PRE${preBlocks.length}\u0000`;
      preBlocks.push(`<pre>${escapeHtml(code.replace(/\n$/, ""))}</pre>`);
      return token;
    },
  );

  // 2. Extract inline code spans (single backticks).
  const codeSpans: string[] = [];
  text = text.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    const token = `\u0000CODE${codeSpans.length}\u0000`;
    codeSpans.push(`<code>${escapeHtml(code)}</code>`);
    return token;
  });

  // 3. Extract links so the text inside doesn't get bold/italic-ed.
  const links: string[] = [];
  text = text.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_m, inner: string, href: string) => {
      const token = `\u0000LINK${links.length}\u0000`;
      links.push(renderLink(inner, href));
      return token;
    },
  );

  // 4. HTML-escape the remaining plain text.
  text = escapeHtml(text);

  // 5. Strip heading markers and blockquote markers to plain text.
  text = text.replace(/^#{1,6}\s+/gm, "");
  text = text.replace(/^>\s?/gm, "");

  // 6. Bullet / numbered lists → keep the dash / number so the reader sees
  //    the structure even without native list rendering.
  text = text.replace(/^[-*+]\s+/gm, "• ");

  // 7. Bold + italic. Order matters — do bold before italic so `**_x_**`
  //    doesn't trip over itself.
  text = text.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  text = text.replace(/__([^_\n]+)__/g, "<b>$1</b>");
  text = text.replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, "$1<i>$2</i>");
  text = text.replace(/(^|[^\w_])_([^_\n]+)_(?!\w)/g, "$1<i>$2</i>");

  // 8. Restore placeholders.
  text = text.replace(
    /\u0000LINK(\d+)\u0000/g,
    (_m, i: string) => links[Number(i)] ?? "",
  );
  text = text.replace(
    /\u0000CODE(\d+)\u0000/g,
    (_m, i: string) => codeSpans[Number(i)] ?? "",
  );
  text = text.replace(
    /\u0000PRE(\d+)\u0000/g,
    (_m, i: string) => preBlocks[Number(i)] ?? "",
  );

  return text;
}

/**
 * Split a long message on paragraph boundaries so each chunk stays under the
 * Telegram 4096-char sendMessage limit. When a single paragraph is itself
 * longer than the limit, a hard slice keeps us under the cap.
 */
export function chunkForSend(
  html: string,
  maxChars = 4000, // leave headroom for `(n/m)` prefix
): string[] {
  if (html.length <= maxChars) return [html];
  const out: string[] = [];
  const paras = html.split(/\n{2,}/);
  let buf = "";
  for (const p of paras) {
    const piece = p.trim();
    if (!piece) continue;
    if (piece.length > maxChars) {
      if (buf) {
        out.push(buf);
        buf = "";
      }
      for (let i = 0; i < piece.length; i += maxChars) {
        out.push(piece.slice(i, i + maxChars));
      }
      continue;
    }
    const candidate = buf ? `${buf}\n\n${piece}` : piece;
    if (candidate.length > maxChars) {
      out.push(buf);
      buf = piece;
    } else {
      buf = candidate;
    }
  }
  if (buf) out.push(buf);
  return out;
}

export interface FormatDecision {
  mode: "html" | "document";
  chunks: string[];
  /** Filename when mode is 'document'. */
  filename?: string;
}

/**
 * Decide whether to send as one-or-more HTML messages or a single
 * `.md` document. The 16 KB ceiling is arbitrary but sane — longer than a few
 * dozen paragraphs and the UX is worse than a one-tap download.
 */
export function decideFormat(
  raw: string,
  opts: { documentFallbackSize?: number; maxChunkChars?: number } = {},
): FormatDecision {
  const fallback = opts.documentFallbackSize ?? 16 * 1024;
  if (raw.length > fallback) {
    return {
      mode: "document",
      chunks: [raw],
      filename: "bunny-reply.md",
    };
  }
  const html = markdownToTelegramHtml(raw);
  const chunks = chunkForSend(html, opts.maxChunkChars ?? 4000);
  if (chunks.length > 1) {
    return {
      mode: "html",
      chunks: chunks.map((c, i) => `(${i + 1}/${chunks.length}) ${c}`),
    };
  }
  return { mode: "html", chunks };
}
