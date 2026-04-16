import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/memory/db.ts";
import {
  createSkill,
  deleteSkill,
  getSkill,
  isSkillLinkedToProject,
  linkSkillToProject,
  listSkills,
  listSkillsForProject,
  listProjectsForSkill,
  mapProjectsBySkill,
  unlinkSkillFromProject,
  updateSkill,
  validateSkillName,
} from "../../src/memory/skills.ts";
import { createProject } from "../../src/memory/projects.ts";

let tmp: string;
async function newDb() {
  tmp = mkdtempSync(join(tmpdir(), "bunny-skills-"));
  return openDb(join(tmp, "test.sqlite"));
}
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("validateSkillName", () => {
  test("accepts simple names", () => {
    expect(validateSkillName("pdf-processing")).toBe("pdf-processing");
    expect(validateSkillName("data_analysis")).toBe("data_analysis");
    expect(validateSkillName("a1")).toBe("a1");
  });
  test("rejects bad names", () => {
    expect(() => validateSkillName("")).toThrow();
    expect(() => validateSkillName(".")).toThrow();
    expect(() => validateSkillName("-leading")).toThrow();
    expect(() => validateSkillName("with space")).toThrow();
    expect(() => validateSkillName("node_modules")).toThrow();
  });
});

describe("skill registry", () => {
  test("create + list + update + delete", async () => {
    const db = await newDb();
    createSkill(db, { name: "pdf-processing", description: "Extract PDF text" });
    createSkill(db, {
      name: "code-review",
      description: "Review code",
      visibility: "public",
      sourceUrl: "https://github.com/example/skills",
      sourceRef: "abc123",
    });
    const list = listSkills(db);
    expect(list.map((s) => s.name).sort()).toEqual(["code-review", "pdf-processing"]);
    const cr = getSkill(db, "code-review")!;
    expect(cr.visibility).toBe("public");
    expect(cr.sourceUrl).toBe("https://github.com/example/skills");
    expect(cr.sourceRef).toBe("abc123");

    const updated = updateSkill(db, "code-review", { description: "Advanced code review" });
    expect(updated.description).toBe("Advanced code review");

    deleteSkill(db, "pdf-processing");
    expect(getSkill(db, "pdf-processing")).toBeNull();
    db.close();
  });

  test("duplicate create throws", async () => {
    const db = await newDb();
    createSkill(db, { name: "dup" });
    expect(() => createSkill(db, { name: "dup" })).toThrow();
    db.close();
  });

  test("update non-existent throws", async () => {
    const db = await newDb();
    expect(() => updateSkill(db, "nope", { description: "x" })).toThrow();
    db.close();
  });
});

describe("project_skills link table", () => {
  test("link + unlink + listSkillsForProject", async () => {
    const db = await newDb();
    createProject(db, { name: "alpha" });
    createProject(db, { name: "beta" });
    createSkill(db, { name: "pdf-processing" });
    createSkill(db, { name: "code-review" });

    linkSkillToProject(db, "alpha", "pdf-processing");
    linkSkillToProject(db, "alpha", "code-review");
    linkSkillToProject(db, "beta", "code-review");

    expect(listSkillsForProject(db, "alpha").map((s) => s.name).sort()).toEqual([
      "code-review",
      "pdf-processing",
    ]);
    expect(listSkillsForProject(db, "beta").map((s) => s.name)).toEqual(["code-review"]);

    expect(isSkillLinkedToProject(db, "alpha", "pdf-processing")).toBe(true);
    expect(isSkillLinkedToProject(db, "beta", "pdf-processing")).toBe(false);

    expect(listProjectsForSkill(db, "code-review").sort()).toEqual(["alpha", "beta"]);

    unlinkSkillFromProject(db, "alpha", "pdf-processing");
    expect(listSkillsForProject(db, "alpha").map((s) => s.name)).toEqual(["code-review"]);
    db.close();
  });

  test("deleteSkill removes project links", async () => {
    const db = await newDb();
    createProject(db, { name: "alpha" });
    createSkill(db, { name: "pdf-processing" });
    linkSkillToProject(db, "alpha", "pdf-processing");
    deleteSkill(db, "pdf-processing");
    expect(isSkillLinkedToProject(db, "alpha", "pdf-processing")).toBe(false);
    db.close();
  });

  test("mapProjectsBySkill", async () => {
    const db = await newDb();
    createProject(db, { name: "alpha" });
    createProject(db, { name: "beta" });
    createSkill(db, { name: "s1" });
    createSkill(db, { name: "s2" });
    linkSkillToProject(db, "alpha", "s1");
    linkSkillToProject(db, "beta", "s1");
    linkSkillToProject(db, "alpha", "s2");

    const map = mapProjectsBySkill(db);
    expect(map.get("s1")?.sort()).toEqual(["alpha", "beta"]);
    expect(map.get("s2")).toEqual(["alpha"]);
    db.close();
  });

  test("duplicate link is idempotent", async () => {
    const db = await newDb();
    createProject(db, { name: "alpha" });
    createSkill(db, { name: "s1" });
    linkSkillToProject(db, "alpha", "s1");
    linkSkillToProject(db, "alpha", "s1");
    expect(listSkillsForProject(db, "alpha")).toHaveLength(1);
    db.close();
  });
});
