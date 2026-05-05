/**
 * Per-file SHA256 cache for graph extractions. A file's extraction is keyed
 * by `sha256(content) + extractorVersion`; on re-runs, we skip the walker /
 * LLM for unchanged files, matching graphify's incremental behaviour.
 *
 * Cache entries live inside `<outDirAbs>/cache/` — a sibling of the cloned
 * repo so the working tree stays clean (see `graphOutDirForRoot` in
 * `run.ts`).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FileExtraction } from "./types.ts";

export function sha256Hex(data: string | Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}

export interface CacheDirs {
  /** Absolute path to `<outDirAbs>/cache/`. */
  cacheDir: string;
}

export function ensureCacheDir(outDirAbs: string): CacheDirs {
  const cacheDir = join(outDirAbs, "cache");
  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
  return { cacheDir };
}

function keyPath(cacheDir: string, cacheKey: string): string {
  return join(cacheDir, `${cacheKey}.json`);
}

/**
 * Read a cached extraction. `cacheKey` should be `sha256(sourceBytes) + "-" +
 * extractorVersion` — the latter lets us invalidate en masse when a walker
 * is rewritten. Returns undefined on miss or parse failure.
 */
export function readCache(
  dirs: CacheDirs,
  cacheKey: string,
): FileExtraction | undefined {
  const path = keyPath(dirs.cacheDir, cacheKey);
  if (!existsSync(path)) return undefined;
  try {
    const text = readFileSync(path, "utf8");
    return JSON.parse(text) as FileExtraction;
  } catch {
    return undefined;
  }
}

export function writeCache(
  dirs: CacheDirs,
  cacheKey: string,
  extraction: FileExtraction,
): void {
  const path = keyPath(dirs.cacheDir, cacheKey);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(extraction), "utf8");
}
