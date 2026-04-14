/**
 * Embedded web bundle manifest.
 *
 * Stub by default — replaced by `scripts/build.ts` just before `bun build
 * --compile` with a version that imports every file under `web/dist/` using
 * `with { type: "file" }`. Bun embeds those bytes into the compiled binary
 * and the imported value is a path that works at runtime.
 *
 * Keep the stub checked in so `bun test` / `bun run src/index.ts` compile
 * without a prior `bun run web:build`.
 */

/** Maps a URL pathname (e.g. "/index.html", "/assets/foo-abc.js") to a
 * Bun-readable path (real FS path in dev, `/$bunfs/...` in a compiled binary). */
export const webBundle: Record<string, string> = {};
