import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileHandler } from "../../src/tools/fs_read.ts";
import { listDirHandler } from "../../src/tools/fs_list.ts";
import { editFileHandler } from "../../src/tools/fs_edit.ts";

// We need a real temp directory that is a child of cwd for path-safety checks,
// but we don't want to pollute the repo. We temporarily change cwd.
let tmp: string;
let originalCwd: string;

beforeAll(() => {
  originalCwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), "bunny-fs-"));
  process.chdir(tmp);
  writeFileSync(join(tmp, "hello.txt"), "line1\nline2\n");
  mkdirSync(join(tmp, "sub"));
  writeFileSync(join(tmp, "sub", "nested.ts"), "export const x = 1;");
});

afterAll(() => {
  process.chdir(originalCwd);
  rmSync(tmp, { recursive: true, force: true });
});

describe("read_file", () => {
  test("reads file content", () => {
    const r = readFileHandler({ path: "hello.txt" });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("line1");
  });

  test("fails on missing file", () => {
    const r = readFileHandler({ path: "does-not-exist.txt" });
    expect(r.ok).toBe(false);
  });

  test("rejects path traversal", () => {
    const r = readFileHandler({ path: "../../etc/passwd" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/escapes/i);
  });

  test("fails on missing path arg", () => {
    const r = readFileHandler({});
    expect(r.ok).toBe(false);
  });
});

describe("list_dir", () => {
  test("lists top-level entries", () => {
    const r = listDirHandler({ path: "." });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("hello.txt");
    expect(r.output).toContain("sub/");
  });

  test("lists nested directory", () => {
    const r = listDirHandler({ path: "sub" });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("nested.ts");
  });

  test("rejects path traversal", () => {
    const r = listDirHandler({ path: "../../" });
    expect(r.ok).toBe(false);
  });

  test("defaults path to '.'", () => {
    const r = listDirHandler({});
    expect(r.ok).toBe(true);
  });
});

describe("edit_file", () => {
  test("replaces a unique string", () => {
    writeFileSync(join(tmp, "edit.txt"), "hello world\n");
    const r = editFileHandler({ path: "edit.txt", old_string: "hello", new_string: "goodbye" });
    expect(r.ok).toBe(true);
    const after = readFileHandler({ path: "edit.txt" });
    expect(after.output).toContain("goodbye world");
  });

  test("rejects when old_string not found", () => {
    writeFileSync(join(tmp, "edit2.txt"), "aaa\n");
    const r = editFileHandler({ path: "edit2.txt", old_string: "zzz", new_string: "x" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not found/i);
  });

  test("rejects when old_string appears more than once", () => {
    writeFileSync(join(tmp, "edit3.txt"), "foo foo foo");
    const r = editFileHandler({ path: "edit3.txt", old_string: "foo", new_string: "bar" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not unique/i);
  });

  test("rejects path traversal", () => {
    const r = editFileHandler({ path: "../../x.txt", old_string: "a", new_string: "b" });
    expect(r.ok).toBe(false);
  });
});
