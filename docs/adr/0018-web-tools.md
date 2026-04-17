# ADR 0018: Web Tools

## Status

Accepted

## Context

Agents had no ability to access the internet — they could not fetch web pages, search for information, or download files. This limited their usefulness for research, data gathering, and workflows involving external resources.

## Decision

Add three closure-bound agent tools in `src/tools/web.ts`:

1. **`web_fetch`** — fetches a URL and returns its content as clean markdown. Uses `node-html-markdown` for HTML-to-markdown conversion. Strips `<script>`, `<style>`, `<nav>`, `<footer>`, `<header>`, `<aside>`, and `<noscript>` tags before conversion for cleaner output. Output capped at 100 KB to protect LLM context.

2. **`web_search`** — searches the internet with a three-tier strategy:
   - **Primary**: SERP API (serper.dev by default) when `[web] serp_api_key` is configured. Reliable, structured JSON response.
   - **Fallback 1**: DuckDuckGo HTML scraping (`html.duckduckgo.com/html/`) when no API key is set. Uses realistic browser headers and retries (5 attempts, exponential backoff) to handle bot protection. Connection errors (IP blocks) break out of the retry loop immediately.
   - **Fallback 2**: Bing HTML scraping when DuckDuckGo is unavailable. Uses a simple user-agent (`curl/7.88.1`) to force server-side rendering (Bing serves JS-only pages to modern browser UAs). Real URLs are extracted from `<cite>` elements rather than Bing's click-tracking redirects.

3. **`web_download`** — downloads a file to the project workspace. Reuses `writeWorkspaceFile` for path safety. Capped at 100 MB.

All three follow the closure-bound factory pattern (like `workspace.ts`), with project and `WebConfig` baked into closures. A `[web]` section in `bunny.config.toml` controls SERP credentials and user-agent.

## Rationale

- **Closure-bound** rather than singleton because `web_download` needs project context for workspace writes, and `web_search` needs the SERP API key from config.
- **`node-html-markdown`** chosen over `turndown` for its lighter footprint and good default behavior with links and images.
- **DuckDuckGo + Bing fallback** ensures search works out-of-the-box without requiring any API key, lowering the barrier to entry. Bing acts as a safety net when DDG rate-limits or IP-blocks the client.
- **Size caps** (100 KB markdown, 100 MB download) prevent accidental context blowup or disk exhaustion.

## Consequences

- New dependency: `node-html-markdown`.
- DuckDuckGo or Bing scraping may break if their HTML structure changes significantly. The SERP API path exists as the reliable alternative.
- `WebConfig` is threaded through `RunAgentOptions` and all `runAgent` callers.
