import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/memory/db.ts";
import { createProject } from "../../src/memory/projects.ts";
import {
  canEditBusiness,
  claimBusinessSoulRefresh,
  createBusiness,
  deleteBusiness,
  findBusinessByDomain,
  findBusinessByName,
  getBusiness,
  listBusinesses,
  releaseStuckBusinessSouls,
  setBusinessAddressAuto,
  setBusinessSoulAuto,
  setBusinessSoulError,
  setBusinessSoulManual,
  updateBusiness,
  upsertBusinessByName,
  validateAddress,
} from "../../src/memory/businesses.ts";
import type { User } from "../../src/auth/users.ts";

let tmp: string;

async function setup() {
  tmp = mkdtempSync(join(tmpdir(), "bunny-businesses-"));
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
  return { db };
}

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("createBusiness + getBusiness", () => {
  test("round-trips with defaults", async () => {
    const { db } = await setup();
    const b = createBusiness(db, {
      project: "alpha",
      name: "Acme Inc.",
      domain: "acme.com",
      createdBy: "owner",
    });
    expect(b.name).toBe("Acme Inc.");
    expect(b.domain).toBe("acme.com");
    expect(b.source).toBe("manual");
    expect(b.soulStatus).toBe("idle");
    expect(b.soul).toBe("");

    const g = getBusiness(db, b.id);
    expect(g?.name).toBe("Acme Inc.");
  });

  test("round-trips socials", async () => {
    const { db } = await setup();
    const b = createBusiness(db, {
      project: "alpha",
      name: "Acme",
      socials: [
        { platform: "twitter", handle: "@acme" },
        {
          platform: "website",
          handle: "https://acme.com",
          url: "https://acme.com",
        },
      ],
      createdBy: "owner",
    });
    expect(b.socials).toHaveLength(2);
    expect(b.socials[0]!.platform).toBe("twitter");
  });
});

describe("upsertBusinessByName (race-safe insert)", () => {
  test("first call creates, second call returns existing id without modifying", async () => {
    const { db } = await setup();
    const a = upsertBusinessByName(db, {
      project: "alpha",
      name: "Acme",
      domain: "acme.com",
      description: "first",
      createdBy: "owner",
    });
    expect(a.created).toBe(true);

    const b = upsertBusinessByName(db, {
      project: "alpha",
      name: "ACME", // case-insensitive collision
      domain: "acme.com",
      description: "should-not-overwrite",
      createdBy: "owner",
    });
    expect(b.created).toBe(false);
    expect(b.id).toBe(a.id);

    const row = getBusiness(db, a.id)!;
    expect(row.description).toBe("first");
  });

  test("domain collision returns existing id", async () => {
    const { db } = await setup();
    const first = upsertBusinessByName(db, {
      project: "alpha",
      name: "Acme",
      domain: "acme.com",
      createdBy: "owner",
    });
    // Same domain, different name spelling
    const second = upsertBusinessByName(db, {
      project: "alpha",
      name: "Acme Inc.",
      domain: "acme.com",
      createdBy: "owner",
    });
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
  });
});

describe("findBy helpers", () => {
  test("findBusinessByName is case-insensitive and project-scoped", async () => {
    const { db } = await setup();
    createProject(db, { name: "beta", createdBy: "owner" });
    createBusiness(db, {
      project: "alpha",
      name: "Acme",
      createdBy: "owner",
    });
    expect(findBusinessByName(db, "alpha", "ACME")?.name).toBe("Acme");
    expect(findBusinessByName(db, "beta", "Acme")).toBeNull();
  });

  test("findBusinessByDomain matches exact domain only", async () => {
    const { db } = await setup();
    createBusiness(db, {
      project: "alpha",
      name: "Acme",
      domain: "acme.com",
      createdBy: "owner",
    });
    expect(findBusinessByDomain(db, "alpha", "acme.com")?.name).toBe("Acme");
    expect(findBusinessByDomain(db, "alpha", "ACME.COM")).toBeNull();
  });
});

describe("soul state machine", () => {
  test("claim → setAuto returns row to idle with sources + cadence", async () => {
    const { db } = await setup();
    const b = createBusiness(db, {
      project: "alpha",
      name: "Acme",
      createdBy: "owner",
    });
    expect(claimBusinessSoulRefresh(db, b.id)).toBe(true);
    expect(getBusiness(db, b.id)!.soulStatus).toBe("refreshing");

    setBusinessSoulAuto(
      db,
      b.id,
      "currently shipping product X",
      [{ url: "https://acme.com/blog", fetchedAt: Date.now() }],
      24 * 60 * 60 * 1000,
    );
    const after = getBusiness(db, b.id)!;
    expect(after.soulStatus).toBe("idle");
    expect(after.soul).toBe("currently shipping product X");
    expect(after.soulSources).toHaveLength(1);
    expect(after.soulRefreshedAt).toBeGreaterThan(0);
    expect(after.soulNextRefreshAt).toBeGreaterThan(after.soulRefreshedAt!);
  });

  test("second claim while refreshing fails", async () => {
    const { db } = await setup();
    const b = createBusiness(db, {
      project: "alpha",
      name: "Acme",
      createdBy: "owner",
    });
    expect(claimBusinessSoulRefresh(db, b.id)).toBe(true);
    expect(claimBusinessSoulRefresh(db, b.id)).toBe(false);
  });

  test("setError flips status and parks next-refresh out one cadence", async () => {
    const { db } = await setup();
    const b = createBusiness(db, {
      project: "alpha",
      name: "Acme",
      createdBy: "owner",
    });
    expect(claimBusinessSoulRefresh(db, b.id)).toBe(true);
    setBusinessSoulError(db, b.id, "boom", 5_000);
    const after = getBusiness(db, b.id)!;
    expect(after.soulStatus).toBe("error");
    expect(after.soulError).toBe("boom");
    expect(after.soulRefreshingAt).toBeNull();
    expect(after.soulNextRefreshAt).toBeGreaterThan(Date.now() - 1_000);
  });

  test("releaseStuckBusinessSouls reclaims rows past the threshold", async () => {
    const { db } = await setup();
    const b = createBusiness(db, {
      project: "alpha",
      name: "Acme",
      createdBy: "owner",
    });
    expect(
      claimBusinessSoulRefresh(db, b.id, Date.now() - 60 * 60 * 1000),
    ).toBe(true);
    const reset = releaseStuckBusinessSouls(db, 30 * 60 * 1000);
    expect(reset).toContain(b.id);
    expect(getBusiness(db, b.id)!.soulStatus).toBe("idle");
  });

  test("setSoulManual stamps manual_edited_at and clamps", async () => {
    const { db } = await setup();
    const b = createBusiness(db, {
      project: "alpha",
      name: "Acme",
      createdBy: "owner",
    });
    setBusinessSoulManual(db, b.id, "operator note");
    const after = getBusiness(db, b.id)!;
    expect(after.soul).toBe("operator note");
    expect(after.soulManualEditedAt).toBeGreaterThan(0);
  });
});

describe("address (auto-fill via soul refresh)", () => {
  test("validateAddress drops empty objects + accepts snake_case keys", () => {
    expect(validateAddress(null)).toBeNull();
    expect(validateAddress({})).toBeNull();
    expect(validateAddress("nope")).toBeNull();
    const a = validateAddress({
      street: "Hoofdstraat 12",
      postal_code: "1234 AB",
      city: " Amsterdam ",
      state: "Noord-Holland",
      country: "NL",
    });
    expect(a).toEqual({
      street: "Hoofdstraat 12",
      postalCode: "1234 AB",
      city: "Amsterdam",
      region: "Noord-Holland",
      country: "NL",
    });
  });

  test("createBusiness round-trips address", async () => {
    const { db } = await setup();
    const b = createBusiness(db, {
      project: "alpha",
      name: "Acme",
      address: { city: "Amsterdam", country: "NL" },
      createdBy: "owner",
    });
    expect(b.address).toEqual({ city: "Amsterdam", country: "NL" });
    expect(b.addressFetchedAt).toBeNull();
  });

  test("setBusinessAddressAuto stamps addressFetchedAt + persists", async () => {
    const { db } = await setup();
    const b = createBusiness(db, {
      project: "alpha",
      name: "Acme",
      createdBy: "owner",
    });
    setBusinessAddressAuto(db, b.id, {
      street: "Hoofdstraat 12",
      city: "Amsterdam",
      country: "NL",
    });
    const after = getBusiness(db, b.id)!;
    expect(after.address?.city).toBe("Amsterdam");
    expect(after.address?.street).toBe("Hoofdstraat 12");
    expect(after.addressFetchedAt).toBeGreaterThan(0);
  });

  test("setBusinessAddressAuto with null/empty does NOT clobber existing", async () => {
    const { db } = await setup();
    const b = createBusiness(db, {
      project: "alpha",
      name: "Acme",
      address: { city: "Amsterdam" },
      createdBy: "owner",
    });
    setBusinessAddressAuto(db, b.id, null);
    setBusinessAddressAuto(db, b.id, {});
    const after = getBusiness(db, b.id)!;
    expect(after.address).toEqual({ city: "Amsterdam" });
  });

  test("updateBusiness can clear address by passing null explicitly", async () => {
    const { db } = await setup();
    const b = createBusiness(db, {
      project: "alpha",
      name: "Acme",
      address: { city: "Amsterdam" },
      createdBy: "owner",
    });
    updateBusiness(db, b.id, { address: null });
    expect(getBusiness(db, b.id)!.address).toBeNull();
  });
});

describe("update + delete + permissions", () => {
  test("updateBusiness changes fields", async () => {
    const { db } = await setup();
    const b = createBusiness(db, {
      project: "alpha",
      name: "Acme",
      createdBy: "owner",
    });
    const updated = updateBusiness(db, b.id, {
      description: "we make widgets",
    });
    expect(updated.description).toBe("we make widgets");
  });

  test("soft-delete hides from list", async () => {
    const { db } = await setup();
    const b = createBusiness(db, {
      project: "alpha",
      name: "Acme",
      createdBy: "owner",
    });
    deleteBusiness(db, b.id, "owner");
    expect(listBusinesses(db, "alpha").total).toBe(0);
    expect(getBusiness(db, b.id)).toBeNull();
  });

  test("canEditBusiness — admin always, creator sometimes", async () => {
    const { db } = await setup();
    const b = createBusiness(db, {
      project: "alpha",
      name: "Acme",
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
      preferredLanguage: null,
      expandThinkBubbles: false,
      expandToolBubbles: false,
    };
    const other: User = {
      id: "other",
      username: "other",
      role: "user",
      mustChangePassword: false,
      displayName: null,
      email: null,
      createdAt: 0,
      updatedAt: 0,
      preferredLanguage: null,
      expandThinkBubbles: false,
      expandToolBubbles: false,
    };
    const project = {
      name: "alpha",
      description: null,
      visibility: "public" as const,
      languages: ["en"],
      defaultLanguage: "en",
      autoBuildBusinesses: false,
      createdBy: "owner",
      createdAt: 0,
      updatedAt: 0,
    };
    expect(canEditBusiness(admin, b, project)).toBe(true);
    expect(canEditBusiness(other, b, project)).toBe(true); // creator
    const stranger: User = { ...other, id: "stranger", username: "stranger" };
    expect(canEditBusiness(stranger, b, project)).toBe(false);
  });
});
