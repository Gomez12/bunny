import { afterEach, beforeEach, describe, expect, test, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureProjectDir } from "../../src/memory/project_assets.ts";
import { readWorkspaceFile } from "../../src/memory/workspace_fs.ts";
import { makeWebTools, WEB_TOOL_NAMES, parseDuckDuckGoResults, parseBingResults } from "../../src/tools/web.ts";
import type { WebConfig } from "../../src/config.ts";

let tmp: string;
const ORIGINAL_HOME = process.env["BUNNY_HOME"];
const originalFetch = globalThis.fetch;

const webCfgNoKey: WebConfig = {
  serpApiKey: "",
  serpProvider: "serper",
  serpBaseUrl: "https://google.serper.dev/search",
  userAgent: "",
};

const webCfgWithKey: WebConfig = {
  serpApiKey: "test-key-123",
  serpProvider: "serper",
  serpBaseUrl: "https://google.serper.dev/search",
  userAgent: "",
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "bunny-webtools-"));
  process.env["BUNNY_HOME"] = tmp;
  ensureProjectDir("alpha");
});
afterEach(() => {
  if (ORIGINAL_HOME === undefined) delete process.env["BUNNY_HOME"];
  else process.env["BUNNY_HOME"] = ORIGINAL_HOME;
  rmSync(tmp, { recursive: true, force: true });
  globalThis.fetch = originalFetch;
});

function tools(cfg: WebConfig = webCfgNoKey) {
  const ts = makeWebTools({ project: "alpha", webCfg: cfg });
  const byName = new Map(ts.map((t) => [t.name, t]));
  return {
    fetch: byName.get("web_fetch")!,
    search: byName.get("web_search")!,
    download: byName.get("web_download")!,
  };
}

function mockFetch(handler: (url: string | URL | Request, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = mock(handler as typeof fetch) as unknown as typeof fetch;
}

describe("web tools", () => {
  test("exported names cover handler set", () => {
    expect([...WEB_TOOL_NAMES].sort()).toEqual(["web_download", "web_fetch", "web_search"]);
  });

  // -----------------------------------------------------------------------
  // web_fetch
  // -----------------------------------------------------------------------

  describe("web_fetch", () => {
    test("converts HTML to markdown with title and links", async () => {
      mockFetch(() =>
        new Response(
          `<html><head><title>Test Page</title></head><body>
           <p>Hello <a href="https://example.com">world</a></p>
           <img src="https://example.com/img.png" alt="photo">
           </body></html>`,
          { headers: { "Content-Type": "text/html" } },
        ),
      );
      const r = await tools().fetch.handler({ url: "https://example.com" });
      expect(r.ok).toBe(true);
      const out = JSON.parse(r.output);
      expect(out.title).toBe("Test Page");
      expect(out.content).toContain("[world](https://example.com)");
      expect(out.content).toContain("![photo](https://example.com/img.png)");
      expect(out.truncated).toBe(false);
    });

    test("strips nav, footer, script, style", async () => {
      mockFetch(() =>
        new Response(
          `<html><head><style>body{}</style><script>alert(1)</script></head><body>
           <nav>Nav stuff</nav><main>Main content</main><footer>Footer</footer>
           </body></html>`,
          { headers: { "Content-Type": "text/html" } },
        ),
      );
      const r = await tools().fetch.handler({ url: "https://example.com" });
      expect(r.ok).toBe(true);
      const out = JSON.parse(r.output);
      expect(out.content).not.toContain("Nav stuff");
      expect(out.content).not.toContain("Footer");
      expect(out.content).not.toContain("alert");
      expect(out.content).toContain("Main content");
    });

    test("truncates at 100KB", async () => {
      const big = "<html><body>" + "a".repeat(200_000) + "</body></html>";
      mockFetch(() => new Response(big, { headers: { "Content-Type": "text/html" } }));
      const r = await tools().fetch.handler({ url: "https://example.com" });
      expect(r.ok).toBe(true);
      const out = JSON.parse(r.output);
      expect(out.truncated).toBe(true);
    });

    test("rejects non-2xx", async () => {
      mockFetch(() => new Response("Not Found", { status: 404, statusText: "Not Found" }));
      const r = await tools().fetch.handler({ url: "https://example.com/missing" });
      expect(r.ok).toBe(false);
      expect(r.output).toContain("404");
    });

    test("rejects binary content-type", async () => {
      mockFetch(() => new Response("bytes", { headers: { "Content-Type": "application/pdf" } }));
      const r = await tools().fetch.handler({ url: "https://example.com/file.pdf" });
      expect(r.ok).toBe(false);
      expect(r.output).toContain("web_download");
    });

    test("missing url returns error", async () => {
      const r = await tools().fetch.handler({});
      expect(r.ok).toBe(false);
    });

    test("rejects non-http url", async () => {
      const r = await tools().fetch.handler({ url: "ftp://example.com" });
      expect(r.ok).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // web_search (SERP)
  // -----------------------------------------------------------------------

  describe("web_search (SERP)", () => {
    test("parses serper.dev response", async () => {
      mockFetch((_url, init) => {
        expect(init?.headers).toBeDefined();
        const headers = init!.headers as Record<string, string>;
        expect(headers["X-API-KEY"]).toBe("test-key-123");
        return new Response(
          JSON.stringify({
            organic: [
              { title: "Result 1", link: "https://r1.com", snippet: "Snippet 1" },
              { title: "Result 2", link: "https://r2.com", snippet: "Snippet 2" },
            ],
          }),
        );
      });
      const r = await tools(webCfgWithKey).search.handler({ query: "bun runtime" });
      expect(r.ok).toBe(true);
      const out = JSON.parse(r.output);
      expect(out.source).toBe("serper");
      expect(out.results).toHaveLength(2);
      expect(out.results[0].title).toBe("Result 1");
      expect(out.results[0].url).toBe("https://r1.com");
    });

    test("clamps max_results to 10", async () => {
      mockFetch((_url, init) => {
        const body = JSON.parse(init!.body as string);
        expect(body.num).toBeLessThanOrEqual(10);
        return new Response(JSON.stringify({ organic: [] }));
      });
      await tools(webCfgWithKey).search.handler({ query: "test", max_results: 20 });
    });
  });

  // -----------------------------------------------------------------------
  // web_search (DuckDuckGo)
  // -----------------------------------------------------------------------

  describe("web_search (DuckDuckGo)", () => {
    test("parseDuckDuckGoResults extracts results from HTML", () => {
      const html = `
        <div class="result results_links results_links_deep web-result">
          <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage">
            <b>Example</b> Page
          </a>
          <a class="result__snippet">This is <b>a snippet</b> about example.</a>
        </div>
        <div class="result results_links results_links_deep web-result">
          <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fother.com">
            Other Site
          </a>
          <a class="result__snippet">Another snippet here.</a>
        </div>
      `;
      const results = parseDuckDuckGoResults(html);
      expect(results).toHaveLength(2);
      expect(results[0]!.title).toBe("Example Page");
      expect(results[0]!.url).toBe("https://example.com/page");
      expect(results[0]!.snippet).toBe("This is a snippet about example.");
      expect(results[1]!.url).toBe("https://other.com");
    });

    test("falls back to DDG when no SERP key", async () => {
      mockFetch(() =>
        new Response(
          `<div class="result results_links web-result">
             <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fbun.sh">Bun</a>
             <a class="result__snippet">Fast JS runtime</a>
           </div>`,
          { headers: { "Content-Type": "text/html" } },
        ),
      );
      const r = await tools(webCfgNoKey).search.handler({ query: "bun runtime" });
      expect(r.ok).toBe(true);
      const out = JSON.parse(r.output);
      expect(out.source).toBe("duckduckgo");
      expect(out.results.length).toBeGreaterThanOrEqual(1);
    });

    test("retries on 403", async () => {
      let calls = 0;
      mockFetch(() => {
        calls++;
        if (calls === 1) return new Response("Forbidden", { status: 403 });
        return new Response(
          `<div class="result results_links web-result">
             <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com">Ex</a>
             <a class="result__snippet">Snip</a>
           </div>`,
          { headers: { "Content-Type": "text/html" } },
        );
      });
      const r = await tools(webCfgNoKey).search.handler({ query: "test" });
      expect(r.ok).toBe(true);
      expect(calls).toBe(2);
    });

    test("missing query returns error", async () => {
      const r = await tools().search.handler({});
      expect(r.ok).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // web_search (Bing fallback)
  // -----------------------------------------------------------------------

  describe("web_search (Bing fallback)", () => {
    test("parseBingResults extracts results from HTML", () => {
      const html = `
        <ol id="b_results">
          <li class="b_algo" data-id>
            <h2><a href="https://www.bing.com/ck/a?abc" h="ID=SERP">Bun — A fast <strong>JavaScript</strong> runtime</a></h2>
            <div class="b_caption"><cite>https://bun.sh</cite></div>
            <p>Bun is a fast all-in-one JavaScript runtime. Bundle, transpile, install and run.</p>
          </li>
          <li class="b_algo" data-id>
            <h2><a href="https://www.bing.com/ck/a?def" h="ID=SERP">GitHub - oven-sh/bun</a></h2>
            <div class="b_caption"><cite>https://github.com/oven-sh/bun</cite></div>
            <p>Incredibly fast JavaScript runtime, bundler, test runner, and package manager.</p>
          </li>
        </ol>
      `;
      const results = parseBingResults(html);
      expect(results).toHaveLength(2);
      expect(results[0]!.title).toBe("Bun — A fast JavaScript runtime");
      expect(results[0]!.url).toBe("https://bun.sh");
      expect(results[0]!.snippet).toContain("fast all-in-one");
      expect(results[1]!.url).toBe("https://github.com/oven-sh/bun");
    });

    test("falls back to Bing when DDG fails completely", async () => {
      mockFetch((url) => {
        const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as Request).url;
        if (urlStr.includes("duckduckgo")) {
          throw new Error("Unable to connect");
        }
        if (urlStr.includes("bing.com/search")) {
          return new Response(`
            <ol id="b_results">
              <li class="b_algo"><h2><a href="/ck/a?x">Example</a></h2><cite>https://example.com</cite><p>A snippet.</p></li>
            </ol>
          `);
        }
        return new Response("");
      });
      const r = await tools(webCfgNoKey).search.handler({ query: "test" });
      expect(r.ok).toBe(true);
      const out = JSON.parse(r.output);
      expect(out.source).toBe("bing");
      expect(out.results.length).toBeGreaterThanOrEqual(1);
      expect(out.results[0].url).toBe("https://example.com");
    });
  });

  // -----------------------------------------------------------------------
  // web_download
  // -----------------------------------------------------------------------

  describe("web_download", () => {
    test("downloads binary file to workspace", async () => {
      const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00]);
      mockFetch(() => new Response(bytes, { headers: { "Content-Type": "application/zip" } }));
      const r = await tools().download.handler({ url: "https://example.com/file.zip", path: "input/file.zip" });
      expect(r.ok).toBe(true);
      const out = JSON.parse(r.output);
      expect(out.path).toBe("input/file.zip");
      expect(out.size).toBe(bytes.byteLength);
      const read = readWorkspaceFile("alpha", "input/file.zip", "base64", 10_000);
      const roundTripped = Buffer.from(read.content, "base64");
      expect(roundTripped).toEqual(bytes);
    });

    test("rejects files over 100MB by Content-Length", async () => {
      mockFetch(() =>
        new Response("", {
          headers: { "Content-Length": String(200 * 1024 * 1024) },
        }),
      );
      const r = await tools().download.handler({ url: "https://example.com/huge.bin", path: "input/huge.bin" });
      expect(r.ok).toBe(false);
      expect(r.output).toContain("too large");
    });

    test("rejects path traversal", async () => {
      mockFetch(() => new Response("data"));
      const r = await tools().download.handler({ url: "https://example.com/x", path: "../../etc/passwd" });
      expect(r.ok).toBe(false);
      expect(r.output).toContain("escapes");
    });

    test("rejects non-2xx", async () => {
      mockFetch(() => new Response("", { status: 500, statusText: "Server Error" }));
      const r = await tools().download.handler({ url: "https://example.com/x", path: "input/x" });
      expect(r.ok).toBe(false);
      expect(r.output).toContain("500");
    });

    test("missing args return error", async () => {
      const { download } = tools();
      expect((await download.handler({})).ok).toBe(false);
      expect((await download.handler({ url: "https://x.com" })).ok).toBe(false);
      expect((await download.handler({ path: "x" })).ok).toBe(false);
    });

    test("rejects non-http url", async () => {
      const r = await tools().download.handler({ url: "ftp://example.com/x", path: "input/x" });
      expect(r.ok).toBe(false);
    });
  });
});
