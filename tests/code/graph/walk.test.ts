import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkCodeProject } from "../../../src/code/graph/walk.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bunny-walk-"));
});

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("walkCodeProject", () => {
  test("collects source files, skips always-ignored directories", () => {
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "node_modules/junk"), { recursive: true });
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, "src/a.ts"), "export {};");
    writeFileSync(join(root, "src/b.py"), "");
    writeFileSync(join(root, "README.md"), "hi");
    writeFileSync(join(root, "node_modules/junk/x.ts"), "");
    writeFileSync(join(root, ".git/HEAD"), "");

    const files = walkCodeProject({
      rootAbs: root,
      maxFiles: 100,
      maxFileSizeKb: 1024,
      includeDocs: false,
    });
    const paths = files.map((f) => f.relPath).sort();
    expect(paths).toEqual(["src/a.ts", "src/b.py"]);
  });

  test("includeDocs toggles Markdown / DOCX inclusion", () => {
    writeFileSync(join(root, "a.ts"), "");
    writeFileSync(join(root, "README.md"), "hi");
    const withoutDocs = walkCodeProject({
      rootAbs: root,
      maxFiles: 100,
      maxFileSizeKb: 1024,
      includeDocs: false,
    });
    expect(withoutDocs.map((f) => f.relPath)).toEqual(["a.ts"]);
    const withDocs = walkCodeProject({
      rootAbs: root,
      maxFiles: 100,
      maxFileSizeKb: 1024,
      includeDocs: true,
    });
    expect(withDocs.map((f) => f.relPath).sort()).toEqual([
      "README.md",
      "a.ts",
    ]);
  });

  test("maxFiles caps the result set", () => {
    for (let i = 0; i < 20; i++) {
      writeFileSync(join(root, `f${i}.ts`), "");
    }
    const capped = walkCodeProject({
      rootAbs: root,
      maxFiles: 5,
      maxFileSizeKb: 1024,
      includeDocs: false,
    });
    expect(capped.length).toBe(5);
  });

  test("maxFileSizeKb skips oversize files", () => {
    writeFileSync(join(root, "tiny.ts"), "export {};");
    writeFileSync(join(root, "huge.ts"), "x".repeat(2048));
    const files = walkCodeProject({
      rootAbs: root,
      maxFiles: 100,
      maxFileSizeKb: 1,
      includeDocs: false,
    });
    expect(files.map((f) => f.relPath)).toEqual(["tiny.ts"]);
  });

  test("honours simple .gitignore patterns at the root", () => {
    writeFileSync(
      join(root, ".gitignore"),
      ["secrets.ts", "*.log", "logs/"].join("\n"),
    );
    mkdirSync(join(root, "logs"), { recursive: true });
    writeFileSync(join(root, "keep.ts"), "");
    writeFileSync(join(root, "secrets.ts"), "");
    writeFileSync(join(root, "debug.log"), "");
    writeFileSync(join(root, "logs/a.ts"), "");
    const files = walkCodeProject({
      rootAbs: root,
      maxFiles: 100,
      maxFileSizeKb: 1024,
      includeDocs: false,
    });
    const paths = files.map((f) => f.relPath).sort();
    expect(paths).toEqual(["keep.ts"]);
  });
});
