import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureCacheDir,
  readCache,
  sha256Hex,
  writeCache,
} from "../../../src/code/graph/cache.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bunny-cache-"));
});

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("cache", () => {
  test("sha256Hex is deterministic", () => {
    expect(sha256Hex("hello")).toBe(sha256Hex("hello"));
    expect(sha256Hex("hello")).not.toBe(sha256Hex("hella"));
  });

  test("ensureCacheDir creates <outDir>/cache/", () => {
    const { cacheDir } = ensureCacheDir(root);
    expect(existsSync(cacheDir)).toBe(true);
    expect(cacheDir.endsWith("/cache")).toBe(true);
  });

  test("writeCache + readCache round-trips a FileExtraction", () => {
    const dirs = ensureCacheDir(root);
    const extraction = {
      nodes: [
        {
          id: "a",
          kind: "module" as const,
          name: "a",
          filePath: "a.ts",
        },
      ],
      edges: [{ from: "a", to: "b", kind: "imports" as const, confidence: 1 }],
    };
    writeCache(dirs, "key1", extraction);
    const read = readCache(dirs, "key1");
    expect(read).toEqual(extraction);
  });

  test("readCache returns undefined on miss", () => {
    const dirs = ensureCacheDir(root);
    expect(readCache(dirs, "nope")).toBeUndefined();
  });
});
