import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureProjectDir,
  workspaceDir,
} from "../../src/memory/project_assets.ts";
import {
  deleteWorkspaceEntry,
  listWorkspace,
  mkdirWorkspace,
  moveWorkspaceEntry,
  readWorkspaceFile,
  safeWorkspacePath,
  writeWorkspaceFile,
} from "../../src/memory/workspace_fs.ts";

let tmp: string;
const ORIGINAL_HOME = process.env["BUNNY_HOME"];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "bunny-workspace-"));
  process.env["BUNNY_HOME"] = tmp;
});
afterEach(() => {
  if (ORIGINAL_HOME === undefined) delete process.env["BUNNY_HOME"];
  else process.env["BUNNY_HOME"] = ORIGINAL_HOME;
  rmSync(tmp, { recursive: true, force: true });
});

describe("workspace fs", () => {
  test("ensureProjectDir creates workspace + input/output", () => {
    ensureProjectDir("alpha");
    const ws = workspaceDir("alpha");
    expect(existsSync(join(ws, "input"))).toBe(true);
    expect(existsSync(join(ws, "output"))).toBe(true);
  });

  test("write + read round-trip (utf8)", () => {
    ensureProjectDir("alpha");
    const w = writeWorkspaceFile(
      "alpha",
      "input/note.md",
      "hello world",
      "utf8",
    );
    expect(w.path).toBe("input/note.md");
    const r = readWorkspaceFile("alpha", "input/note.md");
    expect(r.content).toBe("hello world");
    expect(r.size).toBe(11);
  });

  test("base64 round-trip preserves binary bytes", () => {
    ensureProjectDir("alpha");
    const bytes = new Uint8Array([0, 1, 2, 255, 128]);
    const b64 = Buffer.from(bytes).toString("base64");
    writeWorkspaceFile("alpha", "output/raw.bin", b64, "base64");
    const r = readWorkspaceFile("alpha", "output/raw.bin", "base64");
    expect(r.content).toBe(b64);
    expect(r.size).toBe(5);
  });

  test("read truncates over maxBytes", () => {
    ensureProjectDir("alpha");
    writeWorkspaceFile("alpha", "big.txt", "x".repeat(200), "utf8");
    const r = readWorkspaceFile("alpha", "big.txt", "utf8", 50);
    expect(r.truncated).toBe(true);
    expect(r.returnedBytes).toBe(50);
    expect(r.totalBytes).toBe(200);
    expect(r.content.length).toBe(50);
  });

  test("list returns dirs first, then files, alpha-sorted", () => {
    ensureProjectDir("alpha");
    writeWorkspaceFile("alpha", "b.txt", "b");
    writeWorkspaceFile("alpha", "a.txt", "a");
    mkdirWorkspace("alpha", "zdir");
    const entries = listWorkspace("alpha", "");
    const names = entries.map((e) => `${e.kind}:${e.name}`);
    expect(names.slice(0, 4)).toEqual([
      "dir:code",
      "dir:input",
      "dir:output",
      "dir:zdir",
    ]);
    expect(names.slice(4)).toEqual(["file:a.txt", "file:b.txt"]);
  });

  test("rejects path traversal via ..", () => {
    ensureProjectDir("alpha");
    expect(() => safeWorkspacePath("alpha", "../escape")).toThrow(/escapes/);
    expect(() => readWorkspaceFile("alpha", "../../etc/passwd")).toThrow();
    expect(() => writeWorkspaceFile("alpha", "../oops.txt", "no")).toThrow();
  });

  test("rejects absolute paths", () => {
    ensureProjectDir("alpha");
    expect(() => readWorkspaceFile("alpha", "/etc/passwd")).toThrow();
  });

  test("delete refuses to remove protected input/output roots", () => {
    ensureProjectDir("alpha");
    expect(() => deleteWorkspaceEntry("alpha", "input")).toThrow(/protected/);
    expect(() => deleteWorkspaceEntry("alpha", "output")).toThrow(/protected/);
    // But deleting a file INSIDE input is fine.
    writeWorkspaceFile("alpha", "input/x.txt", "hi");
    deleteWorkspaceEntry("alpha", "input/x.txt");
    expect(existsSync(join(workspaceDir("alpha"), "input/x.txt"))).toBe(false);
  });

  test("move refuses to rename protected roots", () => {
    ensureProjectDir("alpha");
    expect(() => moveWorkspaceEntry("alpha", "input", "renamed")).toThrow(
      /protected/,
    );
  });

  test("move renames files and creates missing parents", () => {
    ensureProjectDir("alpha");
    writeWorkspaceFile("alpha", "a.txt", "payload");
    moveWorkspaceEntry("alpha", "a.txt", "sub/b.txt");
    expect(readWorkspaceFile("alpha", "sub/b.txt").content).toBe("payload");
  });

  test("mkdir creates nested dirs idempotently", () => {
    ensureProjectDir("alpha");
    mkdirWorkspace("alpha", "a/b/c");
    mkdirWorkspace("alpha", "a/b/c"); // no throw
    expect(existsSync(join(workspaceDir("alpha"), "a/b/c"))).toBe(true);
  });

  test("list on empty root returns only seeded subdirs", () => {
    ensureProjectDir("beta");
    const entries = listWorkspace("beta", "");
    expect(entries.map((e) => e.name).sort()).toEqual([
      "code",
      "input",
      "output",
    ]);
  });

  test("stray workspace file from outside ensureProjectDir is still listed", () => {
    ensureProjectDir("alpha");
    writeFileSync(join(workspaceDir("alpha"), "manual.txt"), "hand-placed");
    const e = listWorkspace("alpha", "").find((x) => x.name === "manual.txt");
    expect(e).toBeDefined();
    expect(
      readFileSync(join(workspaceDir("alpha"), "manual.txt"), "utf8"),
    ).toBe("hand-placed");
  });
});
