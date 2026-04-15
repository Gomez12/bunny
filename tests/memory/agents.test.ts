import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/memory/db.ts";
import {
  createAgent,
  deleteAgent,
  getAgent,
  isAgentLinkedToProject,
  linkAgentToProject,
  listAgents,
  listAgentsForProject,
  listProjectsForAgent,
  unlinkAgentFromProject,
  updateAgent,
  validateAgentName,
} from "../../src/memory/agents.ts";
import { createProject } from "../../src/memory/projects.ts";

let tmp: string;
async function newDb() {
  tmp = mkdtempSync(join(tmpdir(), "bunny-agents-"));
  return openDb(join(tmp, "test.sqlite"));
}
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("validateAgentName", () => {
  test("accepts simple names", () => {
    expect(validateAgentName("Bob")).toBe("bob");
    expect(validateAgentName("researcher_1")).toBe("researcher_1");
    expect(validateAgentName("a-b")).toBe("a-b");
  });
  test("rejects bad names", () => {
    expect(() => validateAgentName("")).toThrow();
    expect(() => validateAgentName(".")).toThrow();
    expect(() => validateAgentName("-leading")).toThrow();
    expect(() => validateAgentName("with space")).toThrow();
    expect(() => validateAgentName("node_modules")).toThrow();
  });
});

describe("agent registry", () => {
  test("create + list + update + delete", async () => {
    const db = await newDb();
    createAgent(db, { name: "bob", description: "helper" });
    createAgent(db, {
      name: "ada",
      description: "researcher",
      isSubagent: true,
      contextScope: "own",
      knowsOtherAgents: true,
    });
    const list = listAgents(db);
    expect(list.map((a) => a.name).sort()).toEqual(["ada", "bob"]);
    const ada = getAgent(db, "ada")!;
    expect(ada.isSubagent).toBe(true);
    expect(ada.contextScope).toBe("own");
    expect(ada.knowsOtherAgents).toBe(true);

    const updated = updateAgent(db, "ada", { description: "top researcher", contextScope: "full" });
    expect(updated.description).toBe("top researcher");
    expect(updated.contextScope).toBe("full");

    deleteAgent(db, "bob");
    expect(getAgent(db, "bob")).toBeNull();
    db.close();
  });

  test("duplicate create throws", async () => {
    const db = await newDb();
    createAgent(db, { name: "dup" });
    expect(() => createAgent(db, { name: "dup" })).toThrow();
    db.close();
  });
});

describe("project_agents link table", () => {
  test("link + unlink + listAgentsForProject", async () => {
    const db = await newDb();
    createProject(db, { name: "alpha" });
    createProject(db, { name: "beta" });
    createAgent(db, { name: "bob" });
    createAgent(db, { name: "ada", isSubagent: true });

    linkAgentToProject(db, "alpha", "bob");
    linkAgentToProject(db, "alpha", "ada");
    linkAgentToProject(db, "beta", "ada");

    expect(listAgentsForProject(db, "alpha").map((a) => a.name).sort()).toEqual(["ada", "bob"]);
    expect(listAgentsForProject(db, "beta").map((a) => a.name)).toEqual(["ada"]);

    expect(isAgentLinkedToProject(db, "alpha", "bob")).toBe(true);
    expect(isAgentLinkedToProject(db, "beta", "bob")).toBe(false);

    expect(listProjectsForAgent(db, "ada").sort()).toEqual(["alpha", "beta"]);

    unlinkAgentFromProject(db, "alpha", "bob");
    expect(listAgentsForProject(db, "alpha").map((a) => a.name)).toEqual(["ada"]);
    db.close();
  });

  test("deleteAgent removes project links", async () => {
    const db = await newDb();
    createProject(db, { name: "alpha" });
    createAgent(db, { name: "bob" });
    linkAgentToProject(db, "alpha", "bob");
    deleteAgent(db, "bob");
    expect(isAgentLinkedToProject(db, "alpha", "bob")).toBe(false);
    db.close();
  });
});
