import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Importing these at module-load time forces isomorphic-git + its node http
// transport to resolve through Bun's module loader *at `bun test` time*, not
// only at first-user-click time — catches packaging or API-shape drift.
import git from "isomorphic-git";
import http from "isomorphic-git/http/node";
import {
  cloneCodeProject,
  validateGitUrl,
  workspaceRelForCode,
} from "../../src/code/clone.ts";
import { openDb } from "../../src/memory/db.ts";
import { createProject } from "../../src/memory/projects.ts";
import {
  createCodeProject,
  getCodeProject,
  setGitReady,
} from "../../src/memory/code_projects.ts";
import type { BunnyQueue } from "../../src/queue/bunqueue.ts";

const noopQueue = {
  log: () => {},
  close: async () => {},
} as unknown as BunnyQueue;

const codeCfg = {
  cloneTimeoutMs: 5_000,
  maxRepoSizeMb: 500,
  defaultCloneDepth: 50,
};

describe("validateGitUrl", () => {
  test("accepts https:// and git:// urls", () => {
    expect(validateGitUrl("https://github.com/octocat/Hello-World.git")).toBe(
      "https://github.com/octocat/Hello-World.git",
    );
    expect(validateGitUrl("git://example.org/repo.git")).toBe(
      "git://example.org/repo.git",
    );
  });

  test("rejects ssh:// and scp-style urls", () => {
    expect(() =>
      validateGitUrl("ssh://git@github.com/user/repo.git"),
    ).toThrow();
    expect(() => validateGitUrl("git@github.com:user/repo.git")).toThrow();
  });

  test("rejects file:// and ext:: urls (local-read / RCE surface)", () => {
    expect(() => validateGitUrl("file:///etc/passwd")).toThrow();
    expect(() => validateGitUrl("ext::some-helper")).toThrow();
  });

  test("rejects embedded credentials", () => {
    expect(() =>
      validateGitUrl("https://user:pass@example.com/repo.git"),
    ).toThrow(/credentials/);
  });

  test("rejects non-URL nonsense", () => {
    expect(() => validateGitUrl("")).toThrow();
    expect(() => validateGitUrl(42 as unknown as string)).toThrow();
    expect(() => validateGitUrl("not a url")).toThrow();
  });
});

describe("isomorphic-git runtime wiring", () => {
  test("module resolves and exposes clone() + http transport", () => {
    // Fail loud at `bun test` time rather than at first-user-click time.
    expect(typeof git.clone).toBe("function");
    expect(http).toBeDefined();
  });
});

describe("cloneCodeProject (local + failure paths)", () => {
  let tmp: string;
  const ORIGINAL_HOME = process.env["BUNNY_HOME"];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "bunny-code-clone-"));
    process.env["BUNNY_HOME"] = tmp;
  });

  afterEach(() => {
    if (ORIGINAL_HOME === undefined) delete process.env["BUNNY_HOME"];
    else process.env["BUNNY_HOME"] = ORIGINAL_HOME;
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  test("materialises the empty dir and marks ready when no gitUrl is set", async () => {
    const db = await openDb(join(tmp, "test.sqlite"));
    createProject(db, { name: "alpha" });
    const cp = createCodeProject(db, {
      project: "alpha",
      name: "scratch",
      createdBy: null as unknown as string,
    });
    const ok = await cloneCodeProject(
      { db, queue: noopQueue, cfg: codeCfg, userId: null },
      cp.id,
    );
    expect(ok).toBe(true);
    const after = getCodeProject(db, cp.id);
    expect(after?.gitStatus).toBe("ready");
    const dir = join(
      tmp,
      "projects",
      "alpha",
      "workspace",
      workspaceRelForCode({ name: "scratch" }),
    );
    expect(existsSync(dir)).toBe(true);
    db.close();
  });

  test("transitions to 'error' when the remote is unreachable", async () => {
    const db = await openDb(join(tmp, "test.sqlite"));
    createProject(db, { name: "alpha" });
    const cp = createCodeProject(db, {
      project: "alpha",
      name: "bad-remote",
      // RFC 2606 reserved TLD — DNS lookup fails fast, no real network hit.
      gitUrl: "https://unresolved.invalid/repo.git",
      createdBy: null as unknown as string,
    });
    const ok = await cloneCodeProject(
      {
        db,
        queue: noopQueue,
        cfg: { ...codeCfg, cloneTimeoutMs: 2_000 },
        userId: null,
      },
      cp.id,
    );
    expect(ok).toBe(false);
    const after = getCodeProject(db, cp.id);
    expect(after?.gitStatus).toBe("error");
    expect(after?.gitError).toBeTruthy();
    db.close();
  }, 15_000);

  test("skips the clone and returns false when the row does not exist", async () => {
    const db = await openDb(join(tmp, "test.sqlite"));
    const ok = await cloneCodeProject(
      { db, queue: noopQueue, cfg: codeCfg, userId: null },
      9999,
    );
    expect(ok).toBe(false);
    db.close();
  });

  test("empty project dir materialises idempotently on repeated calls", async () => {
    const db = await openDb(join(tmp, "test.sqlite"));
    createProject(db, { name: "alpha" });
    const cp = createCodeProject(db, {
      project: "alpha",
      name: "twice",
      createdBy: null as unknown as string,
    });
    await cloneCodeProject(
      { db, queue: noopQueue, cfg: codeCfg, userId: null },
      cp.id,
    );
    // Drop a file so we can confirm second-call doesn't wipe local-only state.
    const dir = join(tmp, "projects", "alpha", "workspace", "code", "twice");
    writeFileSync(join(dir, "marker.txt"), "stay", "utf8");
    await cloneCodeProject(
      { db, queue: noopQueue, cfg: codeCfg, userId: null },
      cp.id,
    );
    expect(existsSync(join(dir, "marker.txt"))).toBe(true);
    const after = getCodeProject(db, cp.id);
    expect(after?.gitStatus).toBe("ready");
    // setGitReady is a no-op terminal state + the test asserts file survived.
    setGitReady(db, cp.id);
    db.close();
  });
});
