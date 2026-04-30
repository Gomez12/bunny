import { describe, test, expect } from "bun:test";
import { graphOutDirForRoot } from "../../../src/code/graph/run.ts";

/**
 * Graph artefacts must live *next to* the cloned repo, not inside it, so
 * re-clones don't fight with our scratch state and gitignore drift doesn't
 * make `graph-out/` show up as untracked.
 */
describe("graphOutDirForRoot", () => {
  test("places the out-dir in a `.graph-out` sibling under code/", () => {
    const root = "/srv/.bunny/projects/p/workspace/code/myrepo";
    expect(graphOutDirForRoot(root)).toBe(
      "/srv/.bunny/projects/p/workspace/code/.graph-out/myrepo",
    );
  });

  test("preserves the repo name as the leaf segment", () => {
    expect(graphOutDirForRoot("/a/b/code/foo-bar")).toBe(
      "/a/b/code/.graph-out/foo-bar",
    );
  });

  test("does not produce a path that descends into the repo", () => {
    const root = "/x/code/repo";
    const out = graphOutDirForRoot(root);
    expect(out.startsWith(`${root}/`)).toBe(false);
  });
});
