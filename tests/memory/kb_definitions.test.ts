import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/memory/db.ts";
import { createProject } from "../../src/memory/projects.ts";
import {
  canEditDefinition,
  clearLlmFields,
  createDefinition,
  deleteDefinition,
  getDefinition,
  getDefinitionByTerm,
  listDefinitions,
  setActiveDescription,
  setLlmError,
  setLlmGenerating,
  setLlmResult,
  updateDefinition,
} from "../../src/memory/kb_definitions.ts";
import type { User } from "../../src/auth/users.ts";
import type { Project } from "../../src/memory/projects.ts";

let tmp: string;

function userRow(id: string, role: "admin" | "user"): User {
  return {
    id,
    username: id,
    role,
    mustChangePassword: false,
    displayName: null,
    email: null,
    createdAt: 0,
    updatedAt: 0,
    expandThinkBubbles: false,
    expandToolBubbles: false,
  };
}

async function setup() {
  tmp = mkdtempSync(join(tmpdir(), "bunny-kb-"));
  const db = await openDb(join(tmp, "test.sqlite"));
  const now = Date.now();
  db.run(
    `INSERT INTO users(id, username, password_hash, role, created_at, updated_at)
     VALUES ('owner', 'owner', 'x', 'admin', ?, ?)`,
    [now, now],
  );
  db.run(
    `INSERT INTO users(id, username, password_hash, role, created_at, updated_at)
     VALUES ('other', 'other', 'x', 'user', ?, ?)`,
    [now, now],
  );
  createProject(db, { name: "alpha", createdBy: "owner" });
  createProject(db, { name: "beta", createdBy: "owner" });
  return { db };
}

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("createDefinition", () => {
  test("creates with defaults", async () => {
    const { db } = await setup();
    const d = createDefinition(db, {
      project: "alpha",
      term: "supplier",
      createdBy: "owner",
    });
    expect(d.id).toBeGreaterThan(0);
    expect(d.project).toBe("alpha");
    expect(d.term).toBe("supplier");
    expect(d.manualDescription).toBe("");
    expect(d.llmShort).toBeNull();
    expect(d.llmLong).toBeNull();
    expect(d.llmSources).toEqual([]);
    expect(d.llmCleared).toBe(false);
    expect(d.llmStatus).toBe("idle");
    expect(d.llmError).toBeNull();
    expect(d.llmGeneratedAt).toBeNull();
    expect(d.isProjectDependent).toBe(false);
    expect(d.activeDescription).toBe("manual");
    expect(d.createdBy).toBe("owner");
    db.close();
  });

  test("requires non-empty term", async () => {
    const { db } = await setup();
    expect(() =>
      createDefinition(db, {
        project: "alpha",
        term: "  ",
        createdBy: "owner",
      }),
    ).toThrow("definition term is required");
    db.close();
  });

  test("enforces UNIQUE(project, term) case-insensitively", async () => {
    const { db } = await setup();
    createDefinition(db, {
      project: "alpha",
      term: "Chair",
      createdBy: "owner",
    });
    expect(() =>
      createDefinition(db, {
        project: "alpha",
        term: "chair",
        createdBy: "owner",
      }),
    ).toThrow();
    // Different project — allowed.
    createDefinition(db, {
      project: "beta",
      term: "chair",
      createdBy: "owner",
    });
    db.close();
  });
});

describe("listDefinitions", () => {
  test("scopes by project and sorts by term", async () => {
    const { db } = await setup();
    createDefinition(db, {
      project: "alpha",
      term: "beta",
      createdBy: "owner",
    });
    createDefinition(db, {
      project: "alpha",
      term: "alpha",
      createdBy: "owner",
    });
    createDefinition(db, {
      project: "beta",
      term: "gamma",
      createdBy: "owner",
    });

    const a = listDefinitions(db, "alpha");
    expect(a.total).toBe(2);
    expect(a.definitions.map((d) => d.term)).toEqual(["alpha", "beta"]);

    const b = listDefinitions(db, "beta");
    expect(b.total).toBe(1);
    db.close();
  });

  test("search matches term and manual description", async () => {
    const { db } = await setup();
    createDefinition(db, {
      project: "alpha",
      term: "supplier",
      manualDescription: "Party that delivers parts",
      createdBy: "owner",
    });
    createDefinition(db, {
      project: "alpha",
      term: "chair",
      createdBy: "owner",
    });

    expect(
      listDefinitions(db, "alpha", { search: "supp" }).definitions,
    ).toHaveLength(1);
    expect(
      listDefinitions(db, "alpha", { search: "parts" }).definitions,
    ).toHaveLength(1);
    expect(
      listDefinitions(db, "alpha", { search: "chair" }).definitions,
    ).toHaveLength(1);
    db.close();
  });
});

describe("getDefinitionByTerm", () => {
  test("returns matching row, NULL when missing", async () => {
    const { db } = await setup();
    createDefinition(db, {
      project: "alpha",
      term: "chair",
      createdBy: "owner",
    });
    expect(getDefinitionByTerm(db, "alpha", "chair")?.term).toBe("chair");
    expect(getDefinitionByTerm(db, "alpha", "missing")).toBeNull();
    db.close();
  });
});

describe("updateDefinition", () => {
  test("updates fields partially", async () => {
    const { db } = await setup();
    const d = createDefinition(db, {
      project: "alpha",
      term: "chair",
      createdBy: "owner",
    });
    const up = updateDefinition(db, d.id, {
      manualDescription: "seating furniture",
    });
    expect(up.manualDescription).toBe("seating furniture");
    expect(up.term).toBe("chair");
    db.close();
  });

  test("rejects empty term", async () => {
    const { db } = await setup();
    const d = createDefinition(db, {
      project: "alpha",
      term: "chair",
      createdBy: "owner",
    });
    expect(() => updateDefinition(db, d.id, { term: "  " })).toThrow();
    db.close();
  });

  test("rejects duplicate term within project", async () => {
    const { db } = await setup();
    createDefinition(db, {
      project: "alpha",
      term: "chair",
      createdBy: "owner",
    });
    const d = createDefinition(db, {
      project: "alpha",
      term: "desk",
      createdBy: "owner",
    });
    expect(() => updateDefinition(db, d.id, { term: "chair" })).toThrow();
    db.close();
  });
});

describe("deleteDefinition", () => {
  test("removes the row", async () => {
    const { db } = await setup();
    const d = createDefinition(db, {
      project: "alpha",
      term: "chair",
      createdBy: "owner",
    });
    deleteDefinition(db, d.id);
    expect(getDefinition(db, d.id)).toBeNull();
    db.close();
  });
});

describe("LLM state machine", () => {
  test("generating → result populates fields and leaves cleared=0", async () => {
    const { db } = await setup();
    const d = createDefinition(db, {
      project: "alpha",
      term: "chair",
      createdBy: "owner",
    });

    expect(setLlmGenerating(db, d.id)).toBe(true);
    const mid = getDefinition(db, d.id)!;
    expect(mid.llmStatus).toBe("generating");
    expect(mid.llmError).toBeNull();

    const final = setLlmResult(db, d.id, {
      short: "A piece of seating furniture.",
      long: "A chair is a piece of furniture designed to sit on.",
      sources: [
        { title: "Wikipedia", url: "https://en.wikipedia.org/wiki/Chair" },
      ],
    });
    expect(final.llmStatus).toBe("idle");
    expect(final.llmCleared).toBe(false);
    expect(final.llmShort).toContain("seating");
    expect(final.llmLong).toContain("furniture");
    expect(final.llmSources).toEqual([
      { title: "Wikipedia", url: "https://en.wikipedia.org/wiki/Chair" },
    ]);
    expect(final.llmGeneratedAt).not.toBeNull();
    db.close();
  });

  test("concurrent setLlmGenerating second call loses the race", async () => {
    const { db } = await setup();
    const d = createDefinition(db, {
      project: "alpha",
      term: "chair",
      createdBy: "owner",
    });

    expect(setLlmGenerating(db, d.id)).toBe(true);
    expect(setLlmGenerating(db, d.id)).toBe(false);
    db.close();
  });

  test("setLlmError records the message", async () => {
    const { db } = await setup();
    const d = createDefinition(db, {
      project: "alpha",
      term: "chair",
      createdBy: "owner",
    });
    setLlmGenerating(db, d.id);
    const errored = setLlmError(db, d.id, "boom");
    expect(errored.llmStatus).toBe("error");
    expect(errored.llmError).toBe("boom");
    db.close();
  });

  test("clearLlmFields wipes LLM data, sets cleared=1, resets active to manual", async () => {
    const { db } = await setup();
    const d = createDefinition(db, {
      project: "alpha",
      term: "chair",
      createdBy: "owner",
    });
    setLlmGenerating(db, d.id);
    setLlmResult(db, d.id, {
      short: "s",
      long: "l",
      sources: [{ title: "t", url: "https://example.com" }],
    });
    setActiveDescription(db, d.id, "short");

    const cleared = clearLlmFields(db, d.id);
    expect(cleared.llmShort).toBeNull();
    expect(cleared.llmLong).toBeNull();
    expect(cleared.llmSources).toEqual([]);
    expect(cleared.llmCleared).toBe(true);
    expect(cleared.llmStatus).toBe("idle");
    expect(cleared.llmError).toBeNull();
    expect(cleared.llmGeneratedAt).toBeNull();
    expect(cleared.activeDescription).toBe("manual");
    db.close();
  });
});

describe("setActiveDescription", () => {
  test("accepts manual / short / long", async () => {
    const { db } = await setup();
    const d = createDefinition(db, {
      project: "alpha",
      term: "chair",
      createdBy: "owner",
    });
    expect(setActiveDescription(db, d.id, "short").activeDescription).toBe(
      "short",
    );
    expect(setActiveDescription(db, d.id, "long").activeDescription).toBe(
      "long",
    );
    expect(setActiveDescription(db, d.id, "manual").activeDescription).toBe(
      "manual",
    );
    db.close();
  });

  test("rejects invalid values", async () => {
    const { db } = await setup();
    const d = createDefinition(db, {
      project: "alpha",
      term: "chair",
      createdBy: "owner",
    });
    // @ts-expect-error — intentional bad call
    expect(() => setActiveDescription(db, d.id, "bogus")).toThrow();
    db.close();
  });
});

describe("canEditDefinition", () => {
  const project: Project = {
    name: "alpha",
    description: null,
    visibility: "public",
    createdBy: "owner",
    createdAt: 0,
    updatedAt: 0,
  };

  test("admin can edit any definition", async () => {
    const { db } = await setup();
    const d = createDefinition(db, {
      project: "alpha",
      term: "t",
      createdBy: "other",
    });
    expect(canEditDefinition(userRow("owner", "admin"), d, project)).toBe(true);
    db.close();
  });

  test("creator can edit their own definition", async () => {
    const { db } = await setup();
    const d = createDefinition(db, {
      project: "alpha",
      term: "t",
      createdBy: "other",
    });
    expect(canEditDefinition(userRow("other", "user"), d, project)).toBe(true);
    db.close();
  });

  test("non-owner non-admin cannot edit", async () => {
    const { db } = await setup();
    const d = createDefinition(db, {
      project: "alpha",
      term: "t",
      createdBy: "owner",
    });
    expect(canEditDefinition(userRow("other", "user"), d, project)).toBe(false);
    db.close();
  });
});
