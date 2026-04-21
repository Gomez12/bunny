/**
 * Soft-delete + restore flow for workflows.
 *
 * Guards the trash bin's rename-on-soft-delete dance (`__trash:<id>:<slug>`)
 * and the restore path's `name_conflict` outcome.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/memory/db.ts";
import { createProject } from "../../src/memory/projects.ts";
import {
  createWorkflow,
  getWorkflow,
  listWorkflows,
} from "../../src/memory/workflows.ts";
import {
  hashWorkflowToml,
  writeWorkflowToml,
} from "../../src/memory/workflow_assets.ts";
import { listTrash, restore, softDelete, hardDelete } from "../../src/memory/trash.ts";

let tmp: string;
let originalCwd: string;

beforeAll(() => {
  originalCwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), "bunny-wf-trash-"));
  process.chdir(tmp);
});

afterAll(() => {
  process.chdir(originalCwd);
  rmSync(tmp, { recursive: true, force: true });
});

async function seed(slug: string) {
  const db = await openDb(join(tmp, `${slug}.sqlite`), 4);
  const now = Date.now();
  db.run(
    `INSERT INTO users(id, username, password_hash, role, created_at, updated_at)
     VALUES ('u1', 'u1', 'x', 'user', ?, ?)`,
    [now, now],
  );
  createProject(db, { name: "wf-trash" });
  const toml = `name = "x"\n[[nodes]]\nid = "a"\nprompt = "hi"\n`;
  writeWorkflowToml("wf-trash", slug, toml);
  const wf = createWorkflow(db, {
    project: "wf-trash",
    slug,
    name: "x",
    description: null,
    tomlSha256: hashWorkflowToml(toml),
    createdBy: "u1",
  });
  return { db, wf };
}

describe("workflow trash", () => {
  test("soft-delete mangles the slug and hides from list", async () => {
    const { db, wf } = await seed("delete-me");
    expect(softDelete(db, "workflow", wf.id, "u1")).toBe(true);
    expect(listWorkflows(db, "wf-trash")).toEqual([]);
    const item = listTrash(db).find((i) => i.id === wf.id && i.kind === "workflow");
    expect(item).toBeDefined();
    expect(item!.name).toBe("delete-me");
    db.close();
  });

  test("restore brings it back and strips the prefix", async () => {
    const { db, wf } = await seed("restore-me");
    softDelete(db, "workflow", wf.id, "u1");
    expect(restore(db, "workflow", wf.id)).toBe("ok");
    const fresh = getWorkflow(db, wf.id);
    expect(fresh?.slug).toBe("restore-me");
    db.close();
  });

  test("restore returns name_conflict when a live row took the slug", async () => {
    const { db, wf } = await seed("conflict");
    softDelete(db, "workflow", wf.id, "u1");
    const toml = `name = "x"\n[[nodes]]\nid = "a"\nprompt = "hi"\n`;
    writeWorkflowToml("wf-trash", "conflict", toml);
    createWorkflow(db, {
      project: "wf-trash",
      slug: "conflict",
      name: "x",
      description: null,
      tomlSha256: hashWorkflowToml(toml),
      createdBy: "u1",
    });
    expect(restore(db, "workflow", wf.id)).toBe("name_conflict");
    db.close();
  });

  test("hardDelete removes the row permanently", async () => {
    const { db, wf } = await seed("hard");
    softDelete(db, "workflow", wf.id, "u1");
    expect(hardDelete(db, "workflow", wf.id)).toBe(true);
    expect(getWorkflow(db, wf.id)).toBeNull();
    db.close();
  });
});
