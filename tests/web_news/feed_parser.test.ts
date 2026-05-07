import { describe, it, expect } from "bun:test";
import { parseFeed, detectFeedFormat } from "../../src/web_news/feed_parser.ts";

const RSS_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>Test Blog</title>
    <link>https://example.com</link>
    <item>
      <title>First post</title>
      <link>https://example.com/first</link>
      <description>This is the &lt;b&gt;first&lt;/b&gt; post.</description>
      <pubDate>Mon, 01 Jan 2024 08:00:00 +0000</pubDate>
      <guid>https://example.com/first</guid>
    </item>
    <item>
      <title>Second post</title>
      <link>https://example.com/second</link>
      <description><![CDATA[CDATA content here.]]></description>
      <pubDate>Tue, 02 Jan 2024 08:00:00 +0000</pubDate>
      <media:content url="https://example.com/img.jpg" medium="image" />
    </item>
  </channel>
</rss>`;

const ATOM_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
  <title>Atom Feed</title>
  <entry>
    <title>Atom entry one</title>
    <link rel="alternate" href="https://example.com/atom-one"/>
    <summary>Summary of entry one.</summary>
    <published>2024-03-01T10:00:00Z</published>
    <author><name>Alice</name></author>
  </entry>
  <entry>
    <title>Atom entry two</title>
    <link href="https://example.com/atom-two"/>
    <updated>2024-03-02T10:00:00Z</updated>
    <media:thumbnail url="https://example.com/thumb.jpg"/>
  </entry>
</feed>`;

describe("detectFeedFormat", () => {
  it("detects RSS", () => {
    expect(detectFeedFormat(RSS_FIXTURE)).toBe("rss");
  });

  it("detects Atom", () => {
    expect(detectFeedFormat(ATOM_FIXTURE)).toBe("atom");
  });

  it("returns unknown for HTML", () => {
    expect(detectFeedFormat("<html><body>hello</body></html>")).toBe("unknown");
  });
});

describe("parseFeed — RSS 2.0", () => {
  it("returns format and feed title", () => {
    const result = parseFeed(RSS_FIXTURE);
    expect(result).not.toBeNull();
    expect(result!.format).toBe("rss");
    expect(result!.feedTitle).toBe("Test Blog");
  });

  it("parses two items", () => {
    const result = parseFeed(RSS_FIXTURE)!;
    expect(result.items).toHaveLength(2);
  });

  it("parses title, url, summary", () => {
    const item = parseFeed(RSS_FIXTURE)!.items[0]!;
    expect(item.title).toBe("First post");
    expect(item.url).toBe("https://example.com/first");
    expect(item.summary).toContain("first");
  });

  it("strips HTML tags from description", () => {
    const item = parseFeed(RSS_FIXTURE)!.items[0]!;
    expect(item.summary).not.toContain("<b>");
  });

  it("strips CDATA wrappers", () => {
    const item = parseFeed(RSS_FIXTURE)!.items[1]!;
    expect(item.summary).toBe("CDATA content here.");
  });

  it("parses pubDate as timestamp", () => {
    const item = parseFeed(RSS_FIXTURE)!.items[0]!;
    expect(item.publishedAt).not.toBeNull();
    expect(item.publishedAt).toBeGreaterThan(0);
  });

  it("extracts media:content as imageUrl", () => {
    const item = parseFeed(RSS_FIXTURE)!.items[1]!;
    expect(item.imageUrl).toBe("https://example.com/img.jpg");
  });

  it("returns null for non-feed input", () => {
    expect(parseFeed("<html><body>not a feed</body></html>")).toBeNull();
  });
});

describe("parseFeed — Atom 1.0", () => {
  it("returns format and feed title", () => {
    const result = parseFeed(ATOM_FIXTURE);
    expect(result).not.toBeNull();
    expect(result!.format).toBe("atom");
    expect(result!.feedTitle).toBe("Atom Feed");
  });

  it("parses two entries", () => {
    expect(parseFeed(ATOM_FIXTURE)!.items).toHaveLength(2);
  });

  it("parses title, url, summary for first entry", () => {
    const item = parseFeed(ATOM_FIXTURE)!.items[0]!;
    expect(item.title).toBe("Atom entry one");
    expect(item.url).toBe("https://example.com/atom-one");
    expect(item.summary).toContain("Summary");
  });

  it("extracts author name as source", () => {
    const item = parseFeed(ATOM_FIXTURE)!.items[0]!;
    expect(item.source).toBe("Alice");
  });

  it("parses published date", () => {
    const item = parseFeed(ATOM_FIXTURE)!.items[0]!;
    expect(item.publishedAt).not.toBeNull();
    expect(item.publishedAt).toBeGreaterThan(0);
  });

  it("uses updated when published absent", () => {
    const item = parseFeed(ATOM_FIXTURE)!.items[1]!;
    expect(item.publishedAt).not.toBeNull();
  });

  it("extracts media:thumbnail as imageUrl", () => {
    const item = parseFeed(ATOM_FIXTURE)!.items[1]!;
    expect(item.imageUrl).toBe("https://example.com/thumb.jpg");
  });

  it("falls back to first link when no rel=alternate", () => {
    const item = parseFeed(ATOM_FIXTURE)!.items[1]!;
    expect(item.url).toBe("https://example.com/atom-two");
  });
});

describe("parseFeed — entity decoding", () => {
  it("decodes &amp;", () => {
    const xml = `<rss version="2.0"><channel><title>T</title>
      <item><title>A &amp; B</title><link>https://x.com/a</link></item>
    </channel></rss>`;
    const item = parseFeed(xml)!.items[0]!;
    expect(item.title).toBe("A & B");
  });

  it("strips HTML tags from title after entity decode", () => {
    // &lt;b&gt; → <b> → stripped by cleanText
    const xml = `<rss version="2.0"><channel><title>T</title>
      <item><title>&lt;b&gt;Bold&lt;/b&gt; title</title><link>https://x.com/a</link></item>
    </channel></rss>`;
    const item = parseFeed(xml)!.items[0]!;
    expect(item.title).toBe("Bold title");
  });
});
