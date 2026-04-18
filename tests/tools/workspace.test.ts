import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureProjectDir } from "../../src/memory/project_assets.ts";
import {
  makeWorkspaceTools,
  WORKSPACE_TOOL_NAMES,
} from "../../src/tools/workspace.ts";

let tmp: string;
const ORIGINAL_HOME = process.env["BUNNY_HOME"];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "bunny-wstools-"));
  process.env["BUNNY_HOME"] = tmp;
  ensureProjectDir("alpha");
});
afterEach(() => {
  if (ORIGINAL_HOME === undefined) delete process.env["BUNNY_HOME"];
  else process.env["BUNNY_HOME"] = ORIGINAL_HOME;
  rmSync(tmp, { recursive: true, force: true });
});

function tools() {
  const ts = makeWorkspaceTools({ project: "alpha" });
  const byName = new Map(ts.map((t) => [t.name, t]));
  return {
    list: byName.get("list_workspace_files")!,
    read: byName.get("read_workspace_file")!,
    write: byName.get("write_workspace_file")!,
  };
}

describe("workspace tools", () => {
  test("exported names cover handler set", () => {
    expect([...WORKSPACE_TOOL_NAMES].sort()).toEqual([
      "list_workspace_files",
      "read_workspace_file",
      "write_workspace_file",
    ]);
  });

  test("write → list → read round-trip", async () => {
    const { write, list, read } = tools();
    const w = await write.handler({ path: "output/hello.txt", content: "hi" });
    expect(w.ok).toBe(true);
    const l = await list.handler({ path: "output" });
    expect(l.ok).toBe(true);
    expect(l.output).toContain("hello.txt");
    const r = await read.handler({ path: "output/hello.txt" });
    expect(r.ok).toBe(true);
    const payload = JSON.parse(r.output) as { content: string };
    expect(payload.content).toBe("hi");
  });

  test("read caps utf8 content at 64KB", async () => {
    const { write, read } = tools();
    const big = "a".repeat(70_000);
    await write.handler({ path: "big.txt", content: big });
    const r = await read.handler({ path: "big.txt" });
    const p = JSON.parse(r.output) as {
      truncated?: boolean;
      returnedBytes?: number;
    };
    expect(p.truncated).toBe(true);
    expect(p.returnedBytes).toBe(64 * 1024);
  });

  test("traversal attempt is rejected", async () => {
    const { read } = tools();
    const r = await read.handler({ path: "../../etc/passwd" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/escapes|not found/);
  });

  test("missing required args return error without crashing", async () => {
    const { read, write } = tools();
    expect((await read.handler({})).ok).toBe(false);
    expect((await write.handler({ path: "x" })).ok).toBe(false);
  });

  test("base64 encoding preserves binary bytes", async () => {
    const { write, read } = tools();
    const bytes = Buffer.from([0, 10, 255, 128]).toString("base64");
    await write.handler({
      path: "bin.dat",
      content: bytes,
      encoding: "base64",
    });
    const r = await read.handler({ path: "bin.dat", encoding: "base64" });
    const p = JSON.parse(r.output) as { content: string };
    expect(p.content).toBe(bytes);
  });
});
