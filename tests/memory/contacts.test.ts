import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/memory/db.ts";
import { createProject } from "../../src/memory/projects.ts";
import {
  bulkCreateContacts,
  canEditContact,
  contactToVCard,
  createContact,
  createGroup,
  deleteContact,
  deleteGroup,
  getContact,
  getGroup,
  listContacts,
  listGroups,
  updateContact,
  updateGroup,
} from "../../src/memory/contacts.ts";
import type { User } from "../../src/auth/users.ts";
import type { Project } from "../../src/memory/projects.ts";

let tmp: string;

async function newDb() {
  tmp = mkdtempSync(join(tmpdir(), "bunny-contacts-"));
  return openDb(join(tmp, "test.sqlite"));
}

async function setup() {
  const db = await newDb();
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

describe("createContact", () => {
  test("creates a contact with defaults", async () => {
    const { db } = await setup();
    const c = createContact(db, {
      project: "alpha",
      name: "John Doe",
      createdBy: "owner",
    });
    expect(c.id).toBeGreaterThan(0);
    expect(c.project).toBe("alpha");
    expect(c.name).toBe("John Doe");
    expect(c.emails).toEqual([]);
    expect(c.phones).toEqual([]);
    expect(c.company).toBe("");
    expect(c.tags).toEqual([]);
    expect(c.groups).toEqual([]);
    expect(c.createdBy).toBe("owner");
    db.close();
  });

  test("creates a contact with all fields", async () => {
    const { db } = await setup();
    const c = createContact(db, {
      project: "alpha",
      name: "Jane Smith",
      emails: ["jane@example.com", "j.smith@work.com"],
      phones: ["+31612345678"],
      company: "Acme Corp",
      title: "CEO",
      notes: "Important client",
      tags: ["vip", "client"],
      createdBy: "owner",
    });
    expect(c.emails).toEqual(["jane@example.com", "j.smith@work.com"]);
    expect(c.phones).toEqual(["+31612345678"]);
    expect(c.company).toBe("Acme Corp");
    expect(c.title).toBe("CEO");
    expect(c.notes).toBe("Important client");
    expect(c.tags).toEqual(["vip", "client"]);
    db.close();
  });

  test("requires non-empty name", async () => {
    const { db } = await setup();
    expect(() =>
      createContact(db, { project: "alpha", name: "  ", createdBy: "owner" }),
    ).toThrow("contact name is required");
    db.close();
  });

  test("links to groups on creation", async () => {
    const { db } = await setup();
    const g = createGroup(db, {
      project: "alpha",
      name: "Work",
      createdBy: "owner",
    });
    const c = createContact(db, {
      project: "alpha",
      name: "Bob",
      groups: [g.id],
      createdBy: "owner",
    });
    expect(c.groups).toEqual([g.id]);
    db.close();
  });
});

describe("listContacts", () => {
  test("returns contacts for project", async () => {
    const { db } = await setup();
    createContact(db, { project: "alpha", name: "Alice", createdBy: "owner" });
    createContact(db, { project: "alpha", name: "Bob", createdBy: "owner" });
    createContact(db, { project: "beta", name: "Charlie", createdBy: "owner" });

    const alpha = listContacts(db, "alpha");
    expect(alpha.contacts).toHaveLength(2);
    expect(alpha.contacts.map((c) => c.name)).toEqual(["Alice", "Bob"]);
    expect(alpha.total).toBe(2);

    const beta = listContacts(db, "beta");
    expect(beta.contacts).toHaveLength(1);
    db.close();
  });

  test("search filters by name", async () => {
    const { db } = await setup();
    createContact(db, {
      project: "alpha",
      name: "Alice Wonderland",
      createdBy: "owner",
    });
    createContact(db, {
      project: "alpha",
      name: "Bob Builder",
      createdBy: "owner",
    });

    const { contacts: results } = listContacts(db, "alpha", {
      search: "alice",
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe("Alice Wonderland");
    db.close();
  });

  test("search filters by email", async () => {
    const { db } = await setup();
    createContact(db, {
      project: "alpha",
      name: "Alice",
      emails: ["alice@example.com"],
      createdBy: "owner",
    });
    createContact(db, { project: "alpha", name: "Bob", createdBy: "owner" });

    const { contacts: results } = listContacts(db, "alpha", {
      search: "example.com",
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe("Alice");
    db.close();
  });

  test("filters by group", async () => {
    const { db } = await setup();
    const g = createGroup(db, {
      project: "alpha",
      name: "VIP",
      createdBy: "owner",
    });
    createContact(db, {
      project: "alpha",
      name: "Alice",
      groups: [g.id],
      createdBy: "owner",
    });
    createContact(db, { project: "alpha", name: "Bob", createdBy: "owner" });

    const { contacts: results } = listContacts(db, "alpha", { groupId: g.id });
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe("Alice");
    db.close();
  });

  test("supports limit and offset", async () => {
    const { db } = await setup();
    for (let i = 0; i < 5; i++) {
      createContact(db, {
        project: "alpha",
        name: `Contact ${i}`,
        createdBy: "owner",
      });
    }
    const { contacts: page, total } = listContacts(db, "alpha", {
      limit: 2,
      offset: 2,
    });
    expect(page).toHaveLength(2);
    expect(total).toBe(5);
    db.close();
  });
});

describe("updateContact", () => {
  test("updates fields partially", async () => {
    const { db } = await setup();
    const c = createContact(db, {
      project: "alpha",
      name: "Alice",
      company: "Old Corp",
      createdBy: "owner",
    });
    const updated = updateContact(db, c.id, { company: "New Corp" });
    expect(updated.company).toBe("New Corp");
    expect(updated.name).toBe("Alice");
    db.close();
  });

  test("updates groups", async () => {
    const { db } = await setup();
    const g1 = createGroup(db, {
      project: "alpha",
      name: "A",
      createdBy: "owner",
    });
    const g2 = createGroup(db, {
      project: "alpha",
      name: "B",
      createdBy: "owner",
    });
    const c = createContact(db, {
      project: "alpha",
      name: "X",
      groups: [g1.id],
      createdBy: "owner",
    });
    expect(c.groups).toEqual([g1.id]);

    const updated = updateContact(db, c.id, { groups: [g2.id] });
    expect(updated.groups).toEqual([g2.id]);
    db.close();
  });

  test("throws on missing contact", async () => {
    const { db } = await setup();
    expect(() => updateContact(db, 999, { name: "X" })).toThrow(
      "contact 999 not found",
    );
    db.close();
  });
});

describe("deleteContact", () => {
  test("removes contact and group memberships", async () => {
    const { db } = await setup();
    const g = createGroup(db, {
      project: "alpha",
      name: "G",
      createdBy: "owner",
    });
    const c = createContact(db, {
      project: "alpha",
      name: "X",
      groups: [g.id],
      createdBy: "owner",
    });
    deleteContact(db, c.id);
    expect(getContact(db, c.id)).toBeNull();
    const refreshedGroup = getGroup(db, g.id);
    expect(refreshedGroup!.memberCount).toBe(0);
    db.close();
  });
});

describe("bulkCreateContacts", () => {
  test("creates multiple contacts in transaction", async () => {
    const { db } = await setup();
    const count = bulkCreateContacts(
      db,
      "alpha",
      [
        { name: "A", emails: ["a@x.com"] },
        { name: "B", emails: ["b@x.com"] },
        { name: "C" },
      ],
      "owner",
    );
    expect(count).toBe(3);
    expect(listContacts(db, "alpha").contacts).toHaveLength(3);
    db.close();
  });
});

describe("Contact groups", () => {
  test("CRUD operations", async () => {
    const { db } = await setup();
    const g = createGroup(db, {
      project: "alpha",
      name: "Clients",
      color: "#ff0000",
      createdBy: "owner",
    });
    expect(g.name).toBe("Clients");
    expect(g.color).toBe("#ff0000");
    expect(g.memberCount).toBe(0);

    const updated = updateGroup(db, g.id, { name: "VIP Clients" });
    expect(updated.name).toBe("VIP Clients");

    const groups = listGroups(db, "alpha");
    expect(groups).toHaveLength(1);
    expect(groups[0]!.name).toBe("VIP Clients");

    deleteGroup(db, g.id);
    expect(listGroups(db, "alpha")).toHaveLength(0);
    db.close();
  });

  test("member count reflects linked contacts", async () => {
    const { db } = await setup();
    const g = createGroup(db, {
      project: "alpha",
      name: "Team",
      createdBy: "owner",
    });
    createContact(db, {
      project: "alpha",
      name: "A",
      groups: [g.id],
      createdBy: "owner",
    });
    createContact(db, {
      project: "alpha",
      name: "B",
      groups: [g.id],
      createdBy: "owner",
    });

    const groups = listGroups(db, "alpha");
    expect(groups[0]!.memberCount).toBe(2);
    db.close();
  });

  test("enforces unique (project, name)", async () => {
    const { db } = await setup();
    createGroup(db, { project: "alpha", name: "Team", createdBy: "owner" });
    expect(() =>
      createGroup(db, { project: "alpha", name: "Team", createdBy: "owner" }),
    ).toThrow();
    db.close();
  });
});

describe("canEditContact", () => {
  test("admin can edit any contact", async () => {
    const { db } = await setup();
    const c = createContact(db, {
      project: "alpha",
      name: "X",
      createdBy: "other",
    });
    const admin: User = {
      id: "owner",
      username: "owner",
      role: "admin",
      mustChangePassword: false,
      displayName: null,
      email: null,
      createdAt: 0,
      updatedAt: 0,
      expandThinkBubbles: false,
      expandToolBubbles: false,
    };
    const project = { name: "alpha", createdBy: "owner" } as Project;
    expect(canEditContact(admin, c, project)).toBe(true);
    db.close();
  });

  test("creator can edit own contact", async () => {
    const { db } = await setup();
    const c = createContact(db, {
      project: "alpha",
      name: "X",
      createdBy: "other",
    });
    const user: User = {
      id: "other",
      username: "other",
      role: "user",
      mustChangePassword: false,
      displayName: null,
      email: null,
      createdAt: 0,
      updatedAt: 0,
      expandThinkBubbles: false,
      expandToolBubbles: false,
    };
    const project = { name: "alpha", createdBy: "owner" } as Project;
    expect(canEditContact(user, c, project)).toBe(true);
    db.close();
  });

  test("non-creator, non-admin cannot edit", async () => {
    const { db } = await setup();
    const c = createContact(db, {
      project: "alpha",
      name: "X",
      createdBy: "owner",
    });
    const user: User = {
      id: "other",
      username: "other",
      role: "user",
      mustChangePassword: false,
      displayName: null,
      email: null,
      createdAt: 0,
      updatedAt: 0,
      expandThinkBubbles: false,
      expandToolBubbles: false,
    };
    const project = { name: "alpha", createdBy: "owner" } as Project;
    expect(canEditContact(user, c, project)).toBe(false);
    db.close();
  });
});

describe("contactToVCard", () => {
  test("generates valid vCard 3.0", async () => {
    const { db } = await setup();
    const c = createContact(db, {
      project: "alpha",
      name: "Jane Smith",
      emails: ["jane@example.com"],
      phones: ["+31612345678"],
      company: "Acme",
      title: "CEO",
      createdBy: "owner",
    });
    const vcf = contactToVCard(c);
    expect(vcf).toContain("BEGIN:VCARD");
    expect(vcf).toContain("VERSION:3.0");
    expect(vcf).toContain("FN:Jane Smith");
    expect(vcf).toContain("EMAIL:jane@example.com");
    expect(vcf).toContain("TEL:+31612345678");
    expect(vcf).toContain("ORG:Acme");
    expect(vcf).toContain("TITLE:CEO");
    expect(vcf).toContain("END:VCARD");
    db.close();
  });
});
