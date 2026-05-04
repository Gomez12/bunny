import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/memory/db.ts";
import { createProject } from "../../src/memory/projects.ts";
import {
  claimContactSoulRefresh,
  createContact,
  getContact,
  linkContactBusiness,
  listContactBusinessLinks,
  listContactSoulRefreshCandidates,
  releaseStuckContactSouls,
  setContactSoulAuto,
  setContactSoulManual,
  unlinkContactBusiness,
  validateSocials,
} from "../../src/memory/contacts.ts";
import { createBusiness } from "../../src/memory/businesses.ts";

let tmp: string;

async function setup() {
  tmp = mkdtempSync(join(tmpdir(), "bunny-csoul-"));
  const db = await openDb(join(tmp, "test.sqlite"));
  const now = Date.now();
  db.run(
    `INSERT INTO users(id, username, password_hash, role, created_at, updated_at)
     VALUES ('owner', 'owner', 'x', 'admin', ?, ?)`,
    [now, now],
  );
  createProject(db, { name: "alpha", createdBy: "owner" });
  return { db };
}

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("validateSocials", () => {
  test("filters non-objects + entries with neither handle nor url", () => {
    const result = validateSocials([
      { platform: "twitter", handle: "@anth" },
      { platform: "Linkedin", handle: "  acme  " }, // platform lowercased + handle trimmed
      { platform: "github" }, // no handle no url → drop
      "not an object",
      null,
      { platform: "website", url: "https://acme.com" }, // url-only is OK
    ]);
    expect(result).toEqual([
      { platform: "twitter", handle: "@anth" },
      { platform: "linkedin", handle: "acme" },
      { platform: "website", handle: "", url: "https://acme.com" },
    ]);
  });

  test("returns [] for non-arrays", () => {
    expect(validateSocials(null)).toEqual([]);
    expect(validateSocials({})).toEqual([]);
    expect(validateSocials("nope")).toEqual([]);
  });
});

describe("contact soul state machine", () => {
  test("claim → setAuto returns row to idle with cadence + sources", async () => {
    const { db } = await setup();
    const c = createContact(db, {
      project: "alpha",
      name: "Alice",
      socials: [{ platform: "twitter", handle: "@alice" }],
      createdBy: "owner",
    });
    expect(claimContactSoulRefresh(db, c.id)).toBe(true);
    expect(claimContactSoulRefresh(db, c.id)).toBe(false); // race-loss

    setContactSoulAuto(
      db,
      c.id,
      "currently writing about distributed systems",
      [{ url: "https://twitter.com/alice/status/1", fetchedAt: Date.now() }],
      24 * 60 * 60 * 1000,
    );
    const after = getContact(db, c.id)!;
    expect(after.soulStatus).toBe("idle");
    expect(after.soul).toContain("distributed");
    expect(after.soulSources).toHaveLength(1);
    expect(after.soulNextRefreshAt).toBeGreaterThan(after.soulRefreshedAt!);
  });

  test("manual edit stamps soulManualEditedAt", async () => {
    const { db } = await setup();
    const c = createContact(db, {
      project: "alpha",
      name: "Bob",
      createdBy: "owner",
    });
    setContactSoulManual(db, c.id, "operator override");
    const after = getContact(db, c.id)!;
    expect(after.soul).toBe("operator override");
    expect(after.soulManualEditedAt).toBeGreaterThan(0);
  });

  test("releaseStuckContactSouls reclaims past-threshold rows", async () => {
    const { db } = await setup();
    const c = createContact(db, {
      project: "alpha",
      name: "Carol",
      socials: [{ platform: "twitter", handle: "@carol" }],
      createdBy: "owner",
    });
    expect(claimContactSoulRefresh(db, c.id, Date.now() - 60 * 60 * 1000)).toBe(
      true,
    );
    const reset = releaseStuckContactSouls(db, 30 * 60 * 1000);
    expect(reset).toContain(c.id);
    expect(getContact(db, c.id)!.soulStatus).toBe("idle");
  });

  test("listContactSoulRefreshCandidates skips contacts without socials", async () => {
    const { db } = await setup();
    createContact(db, {
      project: "alpha",
      name: "NoSocial",
      createdBy: "owner",
    });
    const withSocial = createContact(db, {
      project: "alpha",
      name: "WithSocial",
      socials: [{ platform: "twitter", handle: "@x" }],
      createdBy: "owner",
    });
    const candidates = listContactSoulRefreshCandidates(db, { limit: 10 });
    expect(candidates.map((c) => c.id)).toEqual([withSocial.id]);
  });
});

describe("contact ↔ business link helpers", () => {
  test("link → list → unlink round-trip", async () => {
    const { db } = await setup();
    const c = createContact(db, {
      project: "alpha",
      name: "Dave",
      createdBy: "owner",
    });
    const b = createBusiness(db, {
      project: "alpha",
      name: "Acme",
      createdBy: "owner",
    });
    linkContactBusiness(db, c.id, b.id, { role: "Director", isPrimary: true });
    const links = listContactBusinessLinks(db, c.id);
    expect(links).toHaveLength(1);
    expect(links[0]!.businessId).toBe(b.id);
    expect(links[0]!.role).toBe("Director");
    expect(links[0]!.isPrimary).toBe(true);

    // The contact's businessIds reflect the link.
    expect(getContact(db, c.id)!.businessIds).toEqual([b.id]);

    unlinkContactBusiness(db, c.id, b.id);
    expect(listContactBusinessLinks(db, c.id)).toHaveLength(0);
  });

  test("link is idempotent — second call updates role/isPrimary", async () => {
    const { db } = await setup();
    const c = createContact(db, {
      project: "alpha",
      name: "Eve",
      createdBy: "owner",
    });
    const b = createBusiness(db, {
      project: "alpha",
      name: "Acme",
      createdBy: "owner",
    });
    linkContactBusiness(db, c.id, b.id, { role: "Engineer" });
    linkContactBusiness(db, c.id, b.id, { role: "CTO", isPrimary: true });
    const links = listContactBusinessLinks(db, c.id);
    expect(links).toHaveLength(1);
    expect(links[0]!.role).toBe("CTO");
    expect(links[0]!.isPrimary).toBe(true);
  });

  test("soft-deleted business hidden from contact link list", async () => {
    const { db } = await setup();
    const c = createContact(db, {
      project: "alpha",
      name: "Frank",
      createdBy: "owner",
    });
    const b = createBusiness(db, {
      project: "alpha",
      name: "Acme",
      createdBy: "owner",
    });
    linkContactBusiness(db, c.id, b.id);
    db.run(`UPDATE businesses SET deleted_at = ? WHERE id = ?`, [
      Date.now(),
      b.id,
    ]);
    expect(listContactBusinessLinks(db, c.id)).toHaveLength(0);
    expect(getContact(db, c.id)!.businessIds).toEqual([]);
  });
});
