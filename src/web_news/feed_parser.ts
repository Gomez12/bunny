/**
 * Pure-TS RSS 2.0 + Atom 1.0 feed parser.
 *
 * No external dependencies — uses only regex/string matching so it works
 * identically in Bun and unit tests. Handles the common subset of both
 * formats that is reliably present across major feed producers.
 */

export type FeedFormat = "rss" | "atom" | "unknown";

export interface ParsedFeedItem {
  title: string;
  url: string | null;
  summary: string;
  source: string | null;
  imageUrl: string | null;
  publishedAt: number | null;
}

export interface ParsedFeedResult {
  format: FeedFormat;
  feedTitle: string;
  items: ParsedFeedItem[];
}

// ── XML helpers ───────────────────────────────────────────────────────────────

/** Extract first occurrence of <tag ...>content</tag> (non-greedy). */
function extractTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = xml.match(re);
  return m ? decodeEntities(m[1]!.trim()) : null;
}

/** Extract the value of an attribute from the first occurrence of a tag. */
function extractAttr(xml: string, tag: string, attr: string): string | null {
  const re = new RegExp(`<${tag}\\s[^>]*${attr}=["']([^"']*)["'][^>]*>`, "i");
  const m = xml.match(re);
  return m ? m[1]! : null;
}

/** Split XML into repeated tag blocks. Returns the inner content of each. */
function extractBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "gi");
  const blocks: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    blocks.push(m[1]!);
  }
  return blocks;
}

const ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&#39;": "'",
};

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;|&lt;|&gt;|&quot;|&apos;|&#39;/g, (m) => ENTITY_MAP[m] ?? m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

/** Strip CDATA wrappers. */
function stripCdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, inner) => inner);
}

function cleanText(raw: string): string {
  return decodeEntities(stripCdata(raw)).replace(/<[^>]+>/g, "").trim();
}

function parseDate(raw: string | null): number | null {
  if (!raw) return null;
  const cleaned = cleanText(raw);
  if (!cleaned) return null;
  const ts = Date.parse(cleaned);
  return Number.isFinite(ts) ? ts : null;
}

function validHttpUrl(raw: string | null): string | null {
  if (!raw) return null;
  const t = raw.trim();
  return /^https?:\/\//i.test(t) ? t : null;
}

// ── RSS 2.0 ───────────────────────────────────────────────────────────────────

function parseRssItem(block: string): ParsedFeedItem | null {
  const rawTitle = extractTag(block, "title");
  const title = rawTitle ? cleanText(rawTitle) : "";
  if (!title) return null;

  const link = validHttpUrl(cleanText(extractTag(block, "link") ?? ""));
  const guid = validHttpUrl(cleanText(extractTag(block, "guid") ?? ""));
  const url = link ?? guid;

  const descRaw = extractTag(block, "description") ?? extractTag(block, "content:encoded") ?? "";
  const summary = cleanText(descRaw).slice(0, 2000);

  const sourceRaw = extractTag(block, "source");
  const source = sourceRaw ? cleanText(sourceRaw) || null : null;

  // Enclosure image or media:content
  const enclosureUrl = extractAttr(block, "enclosure", "url");
  const mediaUrl = extractAttr(block, "media:content", "url") ?? extractAttr(block, "media:thumbnail", "url");
  const imageUrl = validHttpUrl(enclosureUrl) ?? validHttpUrl(mediaUrl);

  const pubDateRaw = extractTag(block, "pubDate") ?? extractTag(block, "dc:date");
  const publishedAt = parseDate(pubDateRaw);

  return { title, url, summary, source, imageUrl, publishedAt };
}

function parseRss(xml: string): ParsedFeedResult {
  const channelBlock = extractTag(xml, "channel") ?? xml;
  const feedTitle = cleanText(extractTag(channelBlock, "title") ?? "");
  const itemBlocks = extractBlocks(channelBlock, "item");
  const items: ParsedFeedItem[] = [];
  for (const block of itemBlocks) {
    const item = parseRssItem(block);
    if (item) items.push(item);
  }
  return { format: "rss", feedTitle, items };
}

// ── Atom 1.0 ─────────────────────────────────────────────────────────────────

function parseAtomEntry(block: string): ParsedFeedItem | null {
  const rawTitle = extractTag(block, "title");
  const title = rawTitle ? cleanText(rawTitle) : "";
  if (!title) return null;

  // <link rel="alternate" href="..."> or first <link href="...">
  const alternateMatch = block.match(/<link[^>]+rel=["']alternate["'][^>]*href=["']([^"']*)["']/i);
  const anyHrefMatch = block.match(/<link[^>]+href=["']([^"']*)["']/i);
  const url = validHttpUrl(alternateMatch?.[1] ?? anyHrefMatch?.[1] ?? null);

  const summaryRaw = extractTag(block, "summary") ?? extractTag(block, "content") ?? "";
  const summary = cleanText(summaryRaw).slice(0, 2000);

  const authorRaw = extractTag(block, "author");
  const source = authorRaw ? (extractTag(authorRaw, "name") ?? cleanText(authorRaw)) || null : null;

  const mediaUrl = extractAttr(block, "media:thumbnail", "url") ?? extractAttr(block, "media:content", "url");
  const imageUrl = validHttpUrl(mediaUrl);

  const pubRaw = extractTag(block, "published") ?? extractTag(block, "updated");
  const publishedAt = parseDate(pubRaw);

  return { title, url, summary, source: source ? cleanText(source) : null, imageUrl, publishedAt };
}

function parseAtom(xml: string): ParsedFeedResult {
  const feedTitleRaw = (() => {
    // Extract <title> that is a direct child of <feed>, not inside <entry>
    const beforeFirstEntry = xml.split(/<entry[\s>]/i)[0] ?? xml;
    return extractTag(beforeFirstEntry, "title");
  })();
  const feedTitle = feedTitleRaw ? cleanText(feedTitleRaw) : "";
  const entryBlocks = extractBlocks(xml, "entry");
  const items: ParsedFeedItem[] = [];
  for (const block of entryBlocks) {
    const item = parseAtomEntry(block);
    if (item) items.push(item);
  }
  return { format: "atom", feedTitle, items };
}

// ── Public API ────────────────────────────────────────────────────────────────

export function detectFeedFormat(xml: string): FeedFormat {
  const head = xml.trimStart().slice(0, 500);
  if (/<rss\b/i.test(head)) return "rss";
  if (/<feed\b/i.test(head)) return "atom";
  return "unknown";
}

/** Returns true when the Content-Type header indicates an XML feed. */
export function isFeedContentType(contentType: string): boolean {
  return /\b(rss|atom|xml)\b/i.test(contentType);
}

/**
 * Parse an RSS 2.0 or Atom 1.0 feed string.
 * Returns null when the format is unrecognised.
 */
export function parseFeed(xml: string): ParsedFeedResult | null {
  const format = detectFeedFormat(xml);
  if (format === "rss") return parseRss(xml);
  if (format === "atom") return parseAtom(xml);
  return null;
}
