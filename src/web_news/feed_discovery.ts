/**
 * Feed discovery — resolves RSS/Atom feed URLs from an arbitrary URL.
 *
 * Discovery order:
 *   1. Fetch the URL directly; if the response looks like a feed, return it.
 *   2. Parse HTML for <link rel="alternate" type="application/rss+xml|atom+xml">.
 *   3. Probe common paths (/feed, /rss, /feed.xml, /rss.xml, /atom.xml).
 *   4. Pattern matching: compare URL structure against stored feed templates
 *      (e.g. https://github.com/{owner}/{repo} → .../releases.atom).
 *   5. LLM fallback: if nothing found and llmCfg supplied, ask the LLM to
 *      suggest which patterns apply and what the variable values are.
 */

import type { Database } from "bun:sqlite";
import type { LlmConfig } from "../config.ts";
import { chatSync } from "../llm/adapter.ts";
import { detectFeedFormat, isFeedContentType, type FeedFormat } from "./feed_parser.ts";
import { listFeedPatterns, type FeedPattern } from "../memory/web_news.ts";

export interface DiscoveredFeed {
  url: string;
  title: string;
  format: FeedFormat;
}

const TIMEOUT_MS = 10_000;
const COMMON_PATHS = ["/feed", "/rss", "/feed.xml", "/rss.xml", "/atom.xml", "/feeds/posts/default"];

// ── Low-level HTTP helpers ────────────────────────────────────────────────────

async function fetchWithTimeout(url: string): Promise<Response | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetch(url, {
      headers: { "User-Agent": "Bunny-FeedDiscovery/1.0" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res;
  } catch {
    return null;
  }
}

async function probeUrl(url: string): Promise<DiscoveredFeed | null> {
  const res = await fetchWithTimeout(url);
  if (!res || !res.ok) return null;
  const ct = res.headers.get("content-type") ?? "";
  const body = await res.text().catch(() => null);
  if (!body) return null;

  const looksLikeFeed =
    isFeedContentType(ct) ||
    body.trimStart().startsWith("<?xml") ||
    /<(rss|feed)\b/i.test(body.slice(0, 300));
  if (!looksLikeFeed) return null;

  const format = detectFeedFormat(body);
  if (format === "unknown") return null;

  const titleMatch = body.match(/<title(?:\s[^>]*)?>([^<]*)<\/title>/i);
  const title = titleMatch ? titleMatch[1]!.trim() : url;

  return { url, title, format };
}

function extractLinkAlternates(html: string, baseUrl: string): DiscoveredFeed[] {
  const results: DiscoveredFeed[] = [];
  const linkRe = /<link\s[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) {
    const tag = m[0]!;
    if (!/rel=["']alternate["']/i.test(tag)) continue;
    const typeMatch = tag.match(/type=["']([^"']*)["']/i);
    if (!typeMatch) continue;
    const mime = typeMatch[1]!.toLowerCase();
    if (!mime.includes("rss") && !mime.includes("atom") && !mime.includes("xml")) continue;
    const hrefMatch = tag.match(/href=["']([^"']*)["']/i);
    if (!hrefMatch) continue;
    try {
      const resolved = new URL(hrefMatch[1]!, baseUrl).toString();
      const format: FeedFormat = mime.includes("atom") ? "atom" : "rss";
      const titleMatch = tag.match(/title=["']([^"']*)["']/i);
      results.push({ url: resolved, title: titleMatch?.[1] ?? resolved, format });
    } catch {
      // skip malformed hrefs
    }
  }
  return results;
}

// ── Pattern matching (step 4) ─────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface PatternMatcher {
  regex: RegExp;
  varNames: string[];
}

/**
 * Build a regex that matches URLs whose structure implies the given pattern.
 * The regex covers the prefix up to and including the last {variable},
 * allowing any trailing path (so "github.com/owner/repo" matches a pattern
 * like "github.com/{owner}/{repo}/releases.atom").
 */
function buildPatternMatcher(pattern: string): PatternMatcher | null {
  if (!pattern.includes("{")) return null;

  // Split pattern on {variable} placeholders, keeping the delimiters
  const parts = pattern.split(/(\{[^}]+\})/);
  // e.g. ["https://github.com/", "{owner}", "/", "{repo}", "/releases.atom"]

  // Find the index of the last variable part
  let lastVarIdx = -1;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i]!.startsWith("{")) lastVarIdx = i;
  }
  if (lastVarIdx < 0) return null;

  const varNames: string[] = [];
  let regexStr = "^";

  for (let i = 0; i <= lastVarIdx; i++) {
    const part = parts[i]!;
    if (part.startsWith("{") && part.endsWith("}")) {
      const varName = part.slice(1, -1);
      varNames.push(varName);
      // If the following literal starts with "." it's a domain-like variable
      const nextLiteral = (parts[i + 1] as string | undefined) ?? "";
      if (nextLiteral.startsWith(".")) {
        regexStr += "([^.]+)";
      } else {
        regexStr += "([^/]+)";
      }
    } else {
      regexStr += escapeRegex(part);
    }
  }

  // Allow optional trailing path after the last variable's position
  regexStr += "(?:[/?#].*)?$";

  try {
    return { regex: new RegExp(regexStr, "i"), varNames };
  } catch {
    return null;
  }
}

// ── Builtin URL matchers (no DB required) ────────────────────────────────────

type BuiltinMatcher = (url: string) => Array<{ feedUrl: string; label: string }>;

const matchGithub: BuiltinMatcher = (url) => {
  const m = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:[/?#].*)?$/i);
  if (!m) return [];
  const [, owner, repo] = m as [string, string, string];
  return [
    { feedUrl: `https://github.com/${owner}/${repo}/releases.atom`, label: `${owner}/${repo} — Releases` },
    { feedUrl: `https://github.com/${owner}/${repo}/tags.atom`, label: `${owner}/${repo} — Tags` },
    { feedUrl: `https://github.com/${owner}/${repo}/commits/master.atom`, label: `${owner}/${repo} — Commits (master)` },
    { feedUrl: `https://github.com/${owner}/${repo}/commits/main.atom`, label: `${owner}/${repo} — Commits (main)` },
  ];
};

const matchReddit: BuiltinMatcher = (url) => {
  const m = url.match(/^https?:\/\/(?:www\.)?reddit\.com\/r\/([^/?#]+)/i);
  if (!m) return [];
  const [, sub] = m as [string, string];
  return [{ feedUrl: `https://www.reddit.com/r/${sub}/.rss`, label: `r/${sub}` }];
};

const matchSubstack: BuiltinMatcher = (url) => {
  const m = url.match(/^https?:\/\/([^.]+)\.substack\.com/i);
  if (!m) return [];
  const [, sub] = m as [string, string];
  return [{ feedUrl: `https://${sub}.substack.com/feed`, label: `${sub} on Substack` }];
};

const BUILTIN_MATCHERS: BuiltinMatcher[] = [matchGithub, matchReddit, matchSubstack];

async function matchBuiltinPatterns(
  url: string,
  seen: Set<string>,
): Promise<DiscoveredFeed[]> {
  const localSeen = new Set<string>();
  const candidates: Array<{ feedUrl: string; label: string }> = [];
  for (const matcher of BUILTIN_MATCHERS) {
    for (const c of matcher(url)) {
      if (!localSeen.has(c.feedUrl) && !seen.has(c.feedUrl)) {
        localSeen.add(c.feedUrl);
        candidates.push(c);
      }
    }
  }
  if (candidates.length === 0) return [];

  const settled = await Promise.allSettled(
    candidates.map(async (c) => {
      const feed = await probeUrl(c.feedUrl);
      return feed ? { ...feed, title: feed.title || c.label } : null;
    }),
  );
  return settled
    .filter(
      (r): r is PromiseFulfilledResult<DiscoveredFeed> =>
        r.status === "fulfilled" && r.value !== null,
    )
    .map((r) => r.value);
}

async function matchPatternsToUrl(
  url: string,
  patterns: FeedPattern[],
  seen: Set<string>,
): Promise<DiscoveredFeed[]> {
  const candidates: Array<{ feedUrl: string; label: string }> = [];

  for (const p of patterns) {
    const matcher = buildPatternMatcher(p.pattern);

    if (!matcher) {
      // No-variable pattern — skip in pattern-matching step.
      // The user typed a specific URL; a fixed pattern URL is only useful when
      // the user types that exact URL (handled by step 1: direct probe).
      continue;
    }

    const m = url.match(matcher.regex);
    if (!m) continue;

    // Substitute extracted variable values into the full feed pattern
    let feedUrl = p.pattern;
    for (let i = 0; i < matcher.varNames.length; i++) {
      feedUrl = feedUrl.replace(`{${matcher.varNames[i]}}`, m[i + 1] ?? "");
    }

    // Skip if variables weren't fully resolved or result equals input
    if (feedUrl.includes("{") || feedUrl.toLowerCase() === url.toLowerCase()) continue;

    // Check against seen AND already-collected candidates to avoid duplicate probes,
    // but do NOT add to the outer `seen` here — that is add()'s job.
    const alreadyQueued = candidates.some((c) => c.feedUrl === feedUrl);
    if (!seen.has(feedUrl) && !alreadyQueued) {
      candidates.push({ feedUrl, label: `${p.site} — ${p.name}` });
    }
  }

  // Probe all candidates in parallel
  const settled = await Promise.allSettled(
    candidates.map(async (c) => {
      const feed = await probeUrl(c.feedUrl);
      return feed ? { ...feed, title: feed.title || c.label } : null;
    }),
  );

  return settled
    .filter(
      (r): r is PromiseFulfilledResult<DiscoveredFeed> =>
        r.status === "fulfilled" && r.value !== null,
    )
    .map((r) => r.value);
}

// ── LLM fallback (step 5) ─────────────────────────────────────────────────────

async function askLlmForFeeds(
  url: string,
  patterns: FeedPattern[],
  llmCfg: LlmConfig,
  seen: Set<string>,
): Promise<DiscoveredFeed[]> {
  if (patterns.length === 0) return [];

  const patternList = patterns
    .map((p) => `${p.site} — ${p.name}: ${p.pattern}`)
    .join("\n");

  const prompt = `You are an expert on RSS/Atom feeds and URL structures.

URL to analyse: ${url}

Available feed URL patterns (use {variable} placeholders):
${patternList}

Task: Identify which patterns apply to this URL. Extract variable values from the URL structure.

Rules:
- Only include patterns where you are highly confident the URL matches
- Extract variable values directly from the URL (path segments, subdomain, etc.)
- Construct the full feed URL by substituting variables into the pattern

Return JSON only (no extra text):
{"matches":[{"feedUrl":"https://..."}]}

If nothing matches confidently, return {"matches":[]}.`;

  try {
    const response = await chatSync(llmCfg, {
      model: llmCfg.model,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.message.content ?? "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]) as { matches?: unknown };
    const matches = parsed?.matches;
    if (!Array.isArray(matches)) return [];

    // Filter to unique, unseen candidates — do NOT add to seen here.
    const localSeen = new Set<string>();
    const candidates = matches.filter((m): m is { feedUrl: string } => {
      if (typeof m !== "object" || m === null) return false;
      const fu = (m as Record<string, unknown>)["feedUrl"];
      if (typeof fu !== "string") return false;
      if (seen.has(fu) || localSeen.has(fu)) return false;
      localSeen.add(fu);
      return true;
    });

    const settled = await Promise.allSettled(
      candidates.map((c) => probeUrl(c.feedUrl)),
    );

    return settled
      .filter(
        (r): r is PromiseFulfilledResult<DiscoveredFeed> =>
          r.status === "fulfilled" && r.value !== null,
      )
      .map((r) => r.value);
  } catch {
    return [];
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface DiscoverFeedsOpts {
  db?: Database;
  llmCfg?: LlmConfig;
}

/**
 * Discover RSS/Atom feeds for the given URL.
 *
 * Steps 1-3 are always attempted. Step 4 (pattern matching) runs when a `db`
 * is supplied. Step 5 (LLM fallback) runs only when `llmCfg` is supplied and
 * steps 1-4 found nothing.
 *
 * Returns a deduplicated list, most likely first.
 */
export async function discoverFeeds(
  url: string,
  opts: DiscoverFeedsOpts = {},
): Promise<DiscoveredFeed[]> {
  const seen = new Set<string>();
  const results: DiscoveredFeed[] = [];

  function add(feed: DiscoveredFeed) {
    if (!seen.has(feed.url)) {
      seen.add(feed.url);
      results.push(feed);
    }
  }

  // Step 1: Try the URL itself as a feed
  const direct = await probeUrl(url);
  if (direct) {
    add(direct);
    return results;
  }

  // Step 2: Fetch as HTML and look for <link rel="alternate">
  let htmlBody = "";
  const htmlRes = await fetchWithTimeout(url);
  if (htmlRes?.ok) {
    htmlBody = await htmlRes.text().catch(() => "");
    for (const feed of extractLinkAlternates(htmlBody, url)) {
      add(feed);
    }
  }

  // Step 3: Probe common root paths
  let base: string;
  try {
    const parsed = new URL(url);
    base = `${parsed.protocol}//${parsed.host}`;
  } catch {
    return results;
  }

  const rootProbes = await Promise.allSettled(
    COMMON_PATHS.map((p) => probeUrl(base + p)),
  );
  for (const r of rootProbes) {
    if (r.status === "fulfilled" && r.value) add(r.value);
  }

  // Step 4: Run builtin matchers and DB-pattern matchers in parallel.
  // Both do I/O-bound probing; no ordering dependency between them.
  const dbPatternFeeds = opts.db
    ? (async () => {
        try {
          const patterns = listFeedPatterns(opts.db!);
          return await matchPatternsToUrl(url, patterns, seen);
        } catch {
          // web_news_feed_patterns table missing until first restart after migration
          return [] as DiscoveredFeed[];
        }
      })()
    : Promise.resolve([] as DiscoveredFeed[]);

  const [builtin, patternBased] = await Promise.all([
    matchBuiltinPatterns(url, seen),
    dbPatternFeeds,
  ]);
  for (const f of builtin) add(f);
  for (const f of patternBased) add(f);

  // Step 5: LLM fallback when nothing found so far
  if (results.length === 0 && opts.llmCfg && opts.db) {
    try {
      const patterns = listFeedPatterns(opts.db);
      const llmFeeds = await askLlmForFeeds(url, patterns, opts.llmCfg, seen);
      for (const f of llmFeeds) add(f);
    } catch {
      // LLM errors should not break discovery
    }
  }

  return results;
}
