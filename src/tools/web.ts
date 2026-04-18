import type { WebConfig } from "../config.ts";
import type { ToolDescriptor } from "./registry.ts";
import { toolOk, toolErr, getString } from "./registry.ts";
import { errorMessage } from "../util/error.ts";
import { writeWorkspaceFile } from "../memory/workspace_fs.ts";
import { NodeHtmlMarkdown } from "node-html-markdown";

export const WEB_TOOL_NAMES = [
  "web_fetch",
  "web_search",
  "web_download",
] as const;
export type WebToolName = (typeof WEB_TOOL_NAMES)[number];

export interface WebToolContext {
  project: string;
  webCfg: WebConfig;
}

const MAX_MARKDOWN_BYTES = 100 * 1024;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
const DDG_MAX_RETRIES = 5;
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const BING_USER_AGENT = "curl/7.88.1";

export function makeWebTools(ctx: WebToolContext): ToolDescriptor[] {
  return [fetchTool(ctx), searchTool(ctx), downloadTool(ctx)];
}

function getNumber(
  args: Record<string, unknown>,
  key: string,
): number | undefined {
  const v = args[key];
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function ua(cfg: WebConfig): string {
  return cfg.userAgent || DEFAULT_USER_AGENT;
}

function browserHeaders(cfg: WebConfig): Record<string, string> {
  return {
    "User-Agent": ua(cfg),
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function stripTags(html: string, ...tags: string[]): string {
  let result = html;
  for (const tag of tags) {
    result = result.replace(
      new RegExp(`<${tag}[^>]*>[\\s\\S]*?</${tag}>`, "gi"),
      "",
    );
  }
  return result;
}

function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1]!.trim() : "";
}

function fetchTool(ctx: WebToolContext): ToolDescriptor {
  return {
    name: "web_fetch",
    description:
      "Fetch a web page and return its content as clean markdown. Links and image URLs are preserved. Scripts, styles, nav, and footer elements are stripped. Output is capped at ~100 KB.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description:
            "The URL to fetch (must start with http:// or https://).",
        },
      },
      required: ["url"],
    },
    handler: async (args) => {
      const url = getString(args, "url");
      if (!url) return toolErr("missing 'url'");
      if (!/^https?:\/\//i.test(url))
        return toolErr("url must start with http:// or https://");

      try {
        const res = await fetchWithTimeout(url, {
          headers: browserHeaders(ctx.webCfg),
          redirect: "follow",
        });

        if (!res.ok) return toolErr(`HTTP ${res.status} ${res.statusText}`);

        const ct = res.headers.get("content-type") ?? "";
        if (
          !ct.includes("html") &&
          !ct.includes("xml") &&
          !ct.includes("text/plain")
        ) {
          return toolErr(
            `unexpected content-type: ${ct} — use web_download for binary files`,
          );
        }

        let html = await res.text();
        const title = extractTitle(html);
        html = stripTags(
          html,
          "script",
          "style",
          "nav",
          "footer",
          "header",
          "aside",
          "noscript",
        );
        let md = NodeHtmlMarkdown.translate(html);

        let truncated = false;
        const buf = Buffer.from(md, "utf8");
        const contentBytes = buf.byteLength;
        if (contentBytes > MAX_MARKDOWN_BYTES) {
          md = buf.subarray(0, MAX_MARKDOWN_BYTES).toString("utf8");
          truncated = true;
        }

        return toolOk({ url, title, content: md, truncated, contentBytes });
      } catch (e) {
        if ((e as Error).name === "AbortError")
          return toolErr(`request timed out after ${FETCH_TIMEOUT_MS / 1000}s`);
        return toolErr(errorMessage(e));
      }
    },
  };
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

async function serpSearch(
  query: string,
  maxResults: number,
  cfg: WebConfig,
): Promise<SearchResult[]> {
  const res = await fetch(cfg.serpBaseUrl, {
    method: "POST",
    headers: {
      "X-API-KEY": cfg.serpApiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ q: query, num: maxResults }),
  });
  if (!res.ok)
    throw new Error(`SERP API returned ${res.status} ${res.statusText}`);
  const data = (await res.json()) as {
    organic?: Array<{ title?: string; link?: string; snippet?: string }>;
  };
  return (data.organic ?? []).slice(0, maxResults).map((r) => ({
    title: r.title ?? "",
    url: r.link ?? "",
    snippet: r.snippet ?? "",
  }));
}

export function parseDuckDuckGoResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const blockRe =
    /<div[^>]*class="[^"]*result[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?=<div[^>]*class="[^"]*result|$)/gi;
  let block: RegExpExecArray | null;
  while ((block = blockRe.exec(html)) !== null) {
    const chunk = block[1]!;
    const linkMatch = chunk.match(
      /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i,
    );
    if (!linkMatch) continue;
    let href = linkMatch[1]!;
    const uddgMatch = href.match(/[?&]uddg=([^&]+)/);
    if (uddgMatch) href = decodeURIComponent(uddgMatch[1]!);
    const title = linkMatch[2]!.replace(/<[^>]+>/g, "").trim();
    const snippetMatch = chunk.match(
      /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i,
    );
    const snippet = snippetMatch
      ? snippetMatch[1]!.replace(/<[^>]+>/g, "").trim()
      : "";
    results.push({ title, url: href, snippet });
  }
  return results;
}

async function duckduckgoSearch(
  query: string,
  maxResults: number,
  userAgent: string,
): Promise<SearchResult[]> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < DDG_MAX_RETRIES; attempt++) {
    if (attempt > 0)
      await new Promise((r) => setTimeout(r, 3000 * Math.pow(2, attempt - 1)));
    try {
      const res = await fetch("https://html.duckduckgo.com/html/", {
        method: "POST",
        headers: {
          "User-Agent": userAgent || DEFAULT_USER_AGENT,
          Accept: "text/html",
          "Accept-Language": "en-US,en;q=0.9",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: `q=${encodeURIComponent(query)}`,
      });
      if (res.status === 403 || res.status === 429 || res.status === 202) {
        lastError = new Error(`DuckDuckGo returned ${res.status}`);
        continue;
      }
      if (!res.ok)
        throw new Error(`DuckDuckGo returned ${res.status} ${res.statusText}`);
      const html = await res.text();
      if (html.includes("captcha") || html.includes("bot detection")) {
        lastError = new Error("DuckDuckGo CAPTCHA detected");
        continue;
      }
      return parseDuckDuckGoResults(html).slice(0, maxResults);
    } catch (e) {
      lastError = e as Error;
      const msg = lastError.message ?? "";
      if (
        msg.includes("Unable to connect") ||
        msg.includes("ECONNREFUSED") ||
        msg.includes("ENOTFOUND")
      )
        break;
    }
  }
  throw lastError ?? new Error("DuckDuckGo search failed after retries");
}

export function parseBingResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const blocks = html.split(/(?=<li class="b_algo")/);
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i]!;
    const titleMatch = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i);
    if (!titleMatch) continue;
    const title = titleMatch[1]!.replace(/<[^>]+>/g, "").trim();
    const citeMatch = block.match(/<cite[^>]*>([\s\S]*?)<\/cite>/i);
    const url = citeMatch ? citeMatch[1]!.replace(/<[^>]+>/g, "").trim() : "";
    if (!url.startsWith("http")) continue;
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snippetMatch
      ? snippetMatch[1]!
          .replace(/<[^>]+>/g, "")
          .replace(/&nbsp;/g, " ")
          .replace(/&#\d+;/g, "")
          .trim()
      : "";
    results.push({ title, url, snippet });
  }
  return results;
}

async function bingSearch(
  query: string,
  maxResults: number,
): Promise<SearchResult[]> {
  const res = await fetch(
    `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${maxResults}&setlang=en&cc=US`,
    {
      headers: {
        "User-Agent": BING_USER_AGENT,
        Accept: "text/html",
        "Accept-Language": "en-US,en;q=0.9",
      },
    },
  );
  if (!res.ok) throw new Error(`Bing returned ${res.status} ${res.statusText}`);
  const html = await res.text();
  return parseBingResults(html).slice(0, maxResults);
}

async function freeSearch(
  query: string,
  maxResults: number,
  userAgent: string,
): Promise<{ results: SearchResult[]; source: string }> {
  try {
    const results = await duckduckgoSearch(query, maxResults, userAgent);
    return { results, source: "duckduckgo" };
  } catch {
    const results = await bingSearch(query, maxResults);
    return { results, source: "bing" };
  }
}

function searchTool(ctx: WebToolContext): ToolDescriptor {
  return {
    name: "web_search",
    description:
      "Search the internet. Returns up to 10 results with title, URL, and snippet. Uses a SERP API if configured, otherwise falls back to DuckDuckGo then Bing.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query." },
        max_results: {
          type: "integer",
          description: "Number of results to return (1-10, default 10).",
        },
      },
      required: ["query"],
    },
    handler: async (args) => {
      const query = getString(args, "query");
      if (!query) return toolErr("missing 'query'");
      const maxResults = Math.max(
        1,
        Math.min(10, getNumber(args, "max_results") ?? 10),
      );

      try {
        let results: SearchResult[];
        let source: string;
        if (ctx.webCfg.serpApiKey) {
          results = await serpSearch(query, maxResults, ctx.webCfg);
          source = ctx.webCfg.serpProvider;
        } else {
          const free = await freeSearch(query, maxResults, ua(ctx.webCfg));
          results = free.results;
          source = free.source;
        }
        return toolOk({ query, results, source });
      } catch (e) {
        return toolErr(errorMessage(e));
      }
    },
  };
}

function downloadTool(ctx: WebToolContext): ToolDescriptor {
  return {
    name: "web_download",
    description:
      "Download a file from the internet into the project's workspace. For binary files like PDF, XLSX, ZIP, images. Max 100 MB.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to download." },
        path: {
          type: "string",
          description:
            "Workspace-relative file path (e.g. 'input/report.pdf'). Must not escape the workspace.",
        },
      },
      required: ["url", "path"],
    },
    handler: async (args) => {
      const url = getString(args, "url");
      const path = getString(args, "path");
      if (!url) return toolErr("missing 'url'");
      if (!path) return toolErr("missing 'path'");
      if (!/^https?:\/\//i.test(url))
        return toolErr("url must start with http:// or https://");

      try {
        const res = await fetchWithTimeout(url, {
          headers: { "User-Agent": ua(ctx.webCfg) },
          redirect: "follow",
        });

        if (!res.ok) return toolErr(`HTTP ${res.status} ${res.statusText}`);

        const contentLength = Number(res.headers.get("content-length") ?? "0");
        if (contentLength > MAX_DOWNLOAD_BYTES) {
          return toolErr(
            `file too large: ${contentLength} bytes (max ${MAX_DOWNLOAD_BYTES})`,
          );
        }

        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.byteLength > MAX_DOWNLOAD_BYTES) {
          return toolErr(
            `file too large: ${bytes.byteLength} bytes (max ${MAX_DOWNLOAD_BYTES})`,
          );
        }

        const result = writeWorkspaceFile(ctx.project, path, bytes);
        return toolOk({ url, path: result.path, size: result.size });
      } catch (e) {
        if ((e as Error).name === "AbortError")
          return toolErr(
            `download timed out after ${FETCH_TIMEOUT_MS / 1000}s`,
          );
        return toolErr(errorMessage(e));
      }
    },
  };
}
