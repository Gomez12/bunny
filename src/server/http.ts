/**
 * Shared HTTP response helpers for route handlers.
 */

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

export function json(body: unknown, init: number | ResponseInit = 200): Response {
  const responseInit: ResponseInit = typeof init === "number" ? { status: init } : init;
  return new Response(JSON.stringify(body), {
    ...responseInit,
    headers: { ...JSON_HEADERS, ...(responseInit.headers ?? {}) },
  });
}
