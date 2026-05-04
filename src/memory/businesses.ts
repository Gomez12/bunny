/**
 * Per-project Businesses entity (ADR 0036).
 *
 * Sibling of Contacts. Each row carries name, domain, website, emails,
 * phones, socials, plus a periodically refreshed LLM "soul" body. M:N linked
 * to contacts via `contact_businesses` (helpers live in contacts.ts so a
 * single import surface owns the join).
 *
 * Two creation paths:
 * - Manual via the UI / HTTP route — `source = 'manual'`.
 * - Auto-built from contact signals (company names, email domains, website
 *   handles) by the `business.auto_build` handler — `source = 'auto_from_contacts'`.
 *   Race-safe insert via UNIQUE(project, lower(name)) + (project, domain).
 *
 * State machine for `soul_status` mirrors `contacts.soul_status`:
 *   `'idle' → 'refreshing' → ('idle' | 'error')`. Stuck rows reclaimed by the
 * sweep handler at the start of every refresh tick.
 */

import type { Database } from "bun:sqlite";
import type { User } from "../auth/users.ts";
import type { Project } from "./projects.ts";
import {
  ENTITY_SOUL_CHAR_LIMIT,
  ENTITY_SOUL_DEFAULT_CADENCE_MS,
  clampSoul,
} from "./entity_soul_constants.ts";
import {
  createTranslationSlots,
  markAllStale as markTranslationsStale,
  registerKind,
  type TranslatableKind,
} from "./translatable.ts";
import {
  normaliseSoulStatus,
  parseJsonArray,
  parseSoulSources,
  safeJsonParse,
  validateSocials,
  type SocialHandle,
  type SoulSource,
  type SoulStatus,
} from "./contacts.ts";
import { registerTrashable, softDelete } from "./trash.ts";

export const BUSINESS_KIND: TranslatableKind = {
  name: "business",
  entityTable: "businesses",
  sidecarTable: "business_translations",
  entityFk: "business_id",
  sourceFields: ["description", "notes", "soul"],
  sidecarFields: ["description", "notes", "soul"],
  aliveFilter: "deleted_at IS NULL",
};
registerKind(BUSINESS_KIND);

registerTrashable({
  kind: "business",
  table: "businesses",
  nameColumn: "name",
  hasUniqueName: false,
  translationSidecarTable: "business_translations",
  translationSidecarFk: "business_id",
});

export type BusinessSource = "manual" | "auto_from_contacts";

/**
 * Postal address. Every field is optional — auto-fill via soul refresh may
 * only resolve some of them. Country is ISO 3166-1 alpha-2 ("NL", "DE") when
 * the LLM is confident, otherwise free-text.
 */
export interface BusinessAddress {
  street?: string;
  postalCode?: string;
  city?: string;
  region?: string;
  country?: string;
}

/**
 * Sanitise an arbitrary input into a well-formed `BusinessAddress`. Returns
 * null when no field is populated so we don't write `{}` over a previous,
 * non-empty address.
 */
export function validateAddress(input: unknown): BusinessAddress | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  const pick = (key: string) => {
    const v = o[key];
    return typeof v === "string" ? v.trim() : "";
  };
  const out: BusinessAddress = {};
  const street = pick("street");
  const postalCode = pick("postalCode") || pick("postal_code") || pick("zip");
  const city = pick("city");
  const region = pick("region") || pick("state") || pick("province");
  const country = pick("country");
  if (street) out.street = street;
  if (postalCode) out.postalCode = postalCode;
  if (city) out.city = city;
  if (region) out.region = region;
  if (country) out.country = country;
  return Object.keys(out).length > 0 ? out : null;
}

export interface Business {
  id: number;
  project: string;
  name: string;
  domain: string | null;
  description: string;
  notes: string;
  website: string | null;
  emails: string[];
  phones: string[];
  socials: SocialHandle[];
  address: BusinessAddress | null;
  /** Unix ms of the last successful auto-fill via soul refresh. Null = never. */
  addressFetchedAt: number | null;
  logo: string | null;
  tags: string[];
  soul: string;
  soulStatus: SoulStatus;
  soulError: string | null;
  soulRefreshedAt: number | null;
  soulRefreshingAt: number | null;
  soulManualEditedAt: number | null;
  soulNextRefreshAt: number | null;
  soulSources: SoulSource[];
  source: BusinessSource;
  originalLang: string | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

interface BusinessRow {
  id: number;
  project: string;
  name: string;
  domain: string | null;
  description: string;
  notes: string;
  website: string | null;
  emails: string;
  phones: string;
  socials: string;
  address: string | null;
  address_fetched_at: number | null;
  logo: string | null;
  tags: string;
  soul: string;
  soul_status: string;
  soul_error: string | null;
  soul_refreshed_at: number | null;
  soul_refreshing_at: number | null;
  soul_manual_edited_at: number | null;
  soul_next_refresh_at: number | null;
  soul_sources: string | null;
  source: string;
  original_lang: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

const SELECT_COLS = `id, project, name, domain, description, notes, website,
                     emails, phones, socials, address, address_fetched_at,
                     logo, tags,
                     soul, soul_status, soul_error,
                     soul_refreshed_at, soul_refreshing_at, soul_manual_edited_at,
                     soul_next_refresh_at, soul_sources,
                     source, original_lang, created_by, created_at, updated_at`;

/**
 * Slim column projection used by `listBusinesses`. The grid view never reads
 * `soul` (up to 4000 chars), `soul_sources`, `notes`, or `description` — so
 * we replace those large TEXT fields with an empty literal at SELECT time
 * and let `rowToBusiness` see uniform shapes. Keeps the result row
 * `BusinessRow`-compatible without forcing the row mapper to special-case.
 */
const SELECT_COLS_LIST = `id, project, name, domain, '' AS description, '' AS notes, website,
                          emails, phones, socials, address, address_fetched_at,
                          logo, tags,
                          '' AS soul, soul_status, soul_error,
                          soul_refreshed_at, soul_refreshing_at, soul_manual_edited_at,
                          soul_next_refresh_at, NULL AS soul_sources,
                          source, original_lang, created_by, created_at, updated_at`;

function parseAddressField(
  raw: string | null | undefined,
): BusinessAddress | null {
  return validateAddress(safeJsonParse(raw));
}

function normaliseSource(raw: string): BusinessSource {
  return raw === "auto_from_contacts" ? "auto_from_contacts" : "manual";
}

function rowToBusiness(r: BusinessRow): Business {
  return {
    id: r.id,
    project: r.project,
    name: r.name,
    domain: r.domain,
    description: r.description,
    notes: r.notes,
    website: r.website,
    emails: parseJsonArray(r.emails),
    phones: parseJsonArray(r.phones),
    socials: validateSocials(safeJsonParse(r.socials) ?? []),
    address: parseAddressField(r.address),
    addressFetchedAt: r.address_fetched_at,
    logo: r.logo,
    tags: parseJsonArray(r.tags),
    soul: r.soul,
    soulStatus: normaliseSoulStatus(r.soul_status),
    soulError: r.soul_error,
    soulRefreshedAt: r.soul_refreshed_at,
    soulRefreshingAt: r.soul_refreshing_at,
    soulManualEditedAt: r.soul_manual_edited_at,
    soulNextRefreshAt: r.soul_next_refresh_at,
    soulSources: parseSoulSources(r.soul_sources),
    source: normaliseSource(r.source),
    originalLang: r.original_lang,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function resolveOriginalLangForBusiness(
  db: Database,
  project: string,
  explicit: string | undefined,
): string | null {
  if (explicit) return explicit;
  const row = db
    .prepare(`SELECT default_language FROM projects WHERE name = ?`)
    .get(project) as { default_language: string } | undefined;
  return row?.default_language ?? null;
}

// ── List + get ──────────────────────────────────────────────────────────────

export interface ListBusinessesOpts {
  search?: string;
  limit?: number;
  offset?: number;
}

export function listBusinesses(
  db: Database,
  project: string,
  opts?: ListBusinessesOpts,
): { businesses: Business[]; total: number } {
  const where = ["project = ?", "deleted_at IS NULL"];
  const params: (string | number)[] = [project];
  if (opts?.search) {
    const q = `%${opts.search}%`;
    where.push(
      "(name LIKE ? OR domain LIKE ? OR website LIKE ? OR emails LIKE ? OR tags LIKE ?)",
    );
    params.push(q, q, q, q, q);
  }
  const countParams = [...params];
  let sql = `SELECT ${SELECT_COLS_LIST} FROM businesses WHERE ${where.join(" AND ")} ORDER BY name ASC`;
  if (opts?.limit !== undefined) {
    sql += ` LIMIT ?`;
    params.push(opts.limit);
    if (opts.offset !== undefined) {
      sql += ` OFFSET ?`;
      params.push(opts.offset);
    }
  }
  const rows = db.prepare(sql).all(...params) as BusinessRow[];
  const countRow = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM businesses WHERE ${where.join(" AND ")}`,
    )
    .get(...countParams) as { cnt: number };
  return { businesses: rows.map(rowToBusiness), total: countRow.cnt };
}

export function getBusiness(db: Database, id: number): Business | null {
  const row = db
    .prepare(
      `SELECT ${SELECT_COLS} FROM businesses WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(id) as BusinessRow | undefined;
  return row ? rowToBusiness(row) : null;
}

/** Lookup helper: case-insensitive name match within a project, alive only. */
export function findBusinessByName(
  db: Database,
  project: string,
  name: string,
): Business | null {
  const row = db
    .prepare(
      `SELECT ${SELECT_COLS} FROM businesses
        WHERE project = ? AND lower(name) = lower(?) AND deleted_at IS NULL
        LIMIT 1`,
    )
    .get(project, name) as BusinessRow | undefined;
  return row ? rowToBusiness(row) : null;
}

/** Lookup helper: exact domain match within a project, alive only. */
export function findBusinessByDomain(
  db: Database,
  project: string,
  domain: string,
): Business | null {
  const row = db
    .prepare(
      `SELECT ${SELECT_COLS} FROM businesses
        WHERE project = ? AND domain = ? AND deleted_at IS NULL
        LIMIT 1`,
    )
    .get(project, domain) as BusinessRow | undefined;
  return row ? rowToBusiness(row) : null;
}

// ── Create + update ─────────────────────────────────────────────────────────

export interface CreateBusinessOpts {
  project: string;
  name: string;
  domain?: string | null;
  description?: string;
  notes?: string;
  website?: string | null;
  emails?: string[];
  phones?: string[];
  socials?: SocialHandle[];
  address?: BusinessAddress | null;
  logo?: string | null;
  tags?: string[];
  source?: BusinessSource;
  originalLang?: string;
  createdBy: string;
}

export function createBusiness(
  db: Database,
  opts: CreateBusinessOpts,
): Business {
  const name = opts.name.trim();
  if (!name) throw new Error("business name is required");
  const now = Date.now();
  const originalLang = resolveOriginalLangForBusiness(
    db,
    opts.project,
    opts.originalLang,
  );
  const socials = validateSocials(opts.socials ?? []);

  const address = validateAddress(opts.address ?? null);
  const info = db
    .prepare(
      `INSERT INTO businesses(project, name, domain, description, notes, website,
                               emails, phones, socials, address, logo, tags,
                               source, original_lang, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.project,
      name,
      opts.domain ?? null,
      opts.description ?? "",
      opts.notes ?? "",
      opts.website ?? null,
      JSON.stringify(opts.emails ?? []),
      JSON.stringify(opts.phones ?? []),
      JSON.stringify(socials),
      address ? JSON.stringify(address) : null,
      opts.logo ?? null,
      JSON.stringify(opts.tags ?? []),
      opts.source ?? "manual",
      originalLang,
      opts.createdBy,
      now,
      now,
    );
  const id = Number(info.lastInsertRowid);
  createTranslationSlots(db, BUSINESS_KIND, id);
  return getBusiness(db, id)!;
}

/**
 * Race-safe upsert used by the auto_build handler. Inserts when the row is
 * new, returning its id. Returns the existing id (without modifying it) when
 * either UNIQUE index trips. Translation slots are seeded on insert only.
 */
export function upsertBusinessByName(
  db: Database,
  opts: CreateBusinessOpts,
): { id: number; created: boolean } {
  const name = opts.name.trim();
  if (!name) throw new Error("business name is required");
  const now = Date.now();
  const originalLang = resolveOriginalLangForBusiness(
    db,
    opts.project,
    opts.originalLang,
  );
  const socials = validateSocials(opts.socials ?? []);

  const address = validateAddress(opts.address ?? null);
  const inserted = db
    .prepare(
      `INSERT INTO businesses(project, name, domain, description, notes, website,
                               emails, phones, socials, address, logo, tags,
                               source, original_lang, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING
       RETURNING id`,
    )
    .get(
      opts.project,
      name,
      opts.domain ?? null,
      opts.description ?? "",
      opts.notes ?? "",
      opts.website ?? null,
      JSON.stringify(opts.emails ?? []),
      JSON.stringify(opts.phones ?? []),
      JSON.stringify(socials),
      address ? JSON.stringify(address) : null,
      opts.logo ?? null,
      JSON.stringify(opts.tags ?? []),
      opts.source ?? "auto_from_contacts",
      originalLang,
      opts.createdBy,
      now,
      now,
    ) as { id: number } | undefined;
  if (inserted) {
    createTranslationSlots(db, BUSINESS_KIND, inserted.id);
    return { id: inserted.id, created: true };
  }
  // Conflict — find the existing row by name first (more selective), then by domain.
  const byName = findBusinessByName(db, opts.project, name);
  if (byName) return { id: byName.id, created: false };
  if (opts.domain) {
    const byDomain = findBusinessByDomain(db, opts.project, opts.domain);
    if (byDomain) return { id: byDomain.id, created: false };
  }
  throw new Error("upsertBusinessByName: insert blocked but no row found");
}

export interface UpdateBusinessPatch {
  name?: string;
  domain?: string | null;
  description?: string;
  notes?: string;
  website?: string | null;
  emails?: string[];
  phones?: string[];
  socials?: SocialHandle[];
  address?: BusinessAddress | null;
  logo?: string | null;
  tags?: string[];
}

export function updateBusiness(
  db: Database,
  id: number,
  patch: UpdateBusinessPatch,
): Business {
  const existing = getBusiness(db, id);
  if (!existing) throw new Error(`business ${id} not found`);

  const name = patch.name === undefined ? existing.name : patch.name.trim();
  if (!name) throw new Error("business name is required");
  const domain = patch.domain === undefined ? existing.domain : patch.domain;
  const description = patch.description ?? existing.description;
  const notes = patch.notes ?? existing.notes;
  const website =
    patch.website === undefined ? existing.website : patch.website;
  const emails = patch.emails ?? existing.emails;
  const phones = patch.phones ?? existing.phones;
  const socials =
    patch.socials === undefined
      ? existing.socials
      : validateSocials(patch.socials);
  const address =
    patch.address === undefined
      ? existing.address
      : validateAddress(patch.address);
  const logo = patch.logo === undefined ? existing.logo : patch.logo;
  const tags = patch.tags ?? existing.tags;
  const now = Date.now();

  db.prepare(
    `UPDATE businesses
       SET name = ?, domain = ?, description = ?, notes = ?, website = ?,
           emails = ?, phones = ?, socials = ?, address = ?,
           logo = ?, tags = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    name,
    domain,
    description,
    notes,
    website,
    JSON.stringify(emails),
    JSON.stringify(phones),
    JSON.stringify(socials),
    address ? JSON.stringify(address) : null,
    logo,
    JSON.stringify(tags),
    now,
    id,
  );

  // description + notes are translated source fields. Soul changes go through
  // setBusinessSoul* helpers which gate the stale-mark on cfg.businesses.translateSoul.
  if (description !== existing.description || notes !== existing.notes) {
    markTranslationsStale(db, BUSINESS_KIND, id);
  }

  return getBusiness(db, id)!;
}

export function deleteBusiness(
  db: Database,
  id: number,
  deletedBy: string | null = null,
): void {
  softDelete(db, "business", id, deletedBy);
}

export function canEditBusiness(
  user: User,
  business: Business,
  project: Project,
): boolean {
  if (user.role === "admin") return true;
  if (project.createdBy && project.createdBy === user.id) return true;
  if (business.createdBy === user.id) return true;
  return false;
}

// ── Soul (mirror of contacts soul helpers) ───────────────────────────────────

/**
 * Auto-fill the postal address from a soul-refresh extraction. Stamps
 * `address_fetched_at` so the UI can show "fetched ago". Skipped when the
 * input is empty (never blanks an existing address) or when the new value
 * is byte-identical to what's already stored — that second guard avoids
 * pointless `updated_at` churn when the website hasn't changed.
 */
export function setBusinessAddressAuto(
  db: Database,
  id: number,
  address: BusinessAddress | null,
): void {
  const cleaned = validateAddress(address);
  if (!cleaned) return;
  const serialised = JSON.stringify(cleaned);
  const current = db
    .prepare(
      `SELECT address FROM businesses WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(id) as { address: string | null } | undefined;
  if (!current) return;
  if (current.address === serialised) {
    db.prepare(`UPDATE businesses SET address_fetched_at = ? WHERE id = ?`).run(
      Date.now(),
      id,
    );
    return;
  }
  const now = Date.now();
  db.prepare(
    `UPDATE businesses
       SET address = ?, address_fetched_at = ?, updated_at = ?
     WHERE id = ?`,
  ).run(serialised, now, now, id);
}

export function setBusinessSoulManual(
  db: Database,
  id: number,
  soul: string,
  opts: { markStale?: boolean } = {},
): void {
  if (soul.length > ENTITY_SOUL_CHAR_LIMIT) {
    throw new Error(
      `soul exceeds ${ENTITY_SOUL_CHAR_LIMIT}-char cap (got ${soul.length})`,
    );
  }
  const now = Date.now();
  db.prepare(
    `UPDATE businesses
       SET soul = ?, soul_manual_edited_at = ?, updated_at = ?
     WHERE id = ? AND deleted_at IS NULL`,
  ).run(soul, now, now, id);
  if (opts.markStale) markTranslationsStale(db, BUSINESS_KIND, id);
}

export function setBusinessSoulAuto(
  db: Database,
  id: number,
  soul: string,
  sources: SoulSource[],
  cadenceMs: number = ENTITY_SOUL_DEFAULT_CADENCE_MS,
  opts: { markStale?: boolean } = {},
): void {
  const trimmed = clampSoul(soul);
  const now = Date.now();
  const next = now + cadenceMs;
  db.prepare(
    `UPDATE businesses
       SET soul = ?, soul_sources = ?, soul_status = 'idle', soul_error = NULL,
           soul_refreshing_at = NULL, soul_refreshed_at = ?, soul_next_refresh_at = ?,
           updated_at = ?
     WHERE id = ? AND deleted_at IS NULL`,
  ).run(trimmed, JSON.stringify(sources), now, next, now, id);
  if (opts.markStale) markTranslationsStale(db, BUSINESS_KIND, id);
}

export function claimBusinessSoulRefresh(
  db: Database,
  id: number,
  now: number = Date.now(),
): boolean {
  const info = db
    .prepare(
      `UPDATE businesses
         SET soul_status = 'refreshing', soul_refreshing_at = ?, soul_error = NULL, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL AND soul_status != 'refreshing'`,
    )
    .run(now, now, id);
  return info.changes > 0;
}

export function setBusinessSoulError(
  db: Database,
  id: number,
  error: string,
  cadenceMs: number = ENTITY_SOUL_DEFAULT_CADENCE_MS,
): void {
  const now = Date.now();
  const next = now + cadenceMs;
  db.prepare(
    `UPDATE businesses
       SET soul_status = 'error', soul_error = ?, soul_refreshing_at = NULL,
           soul_next_refresh_at = ?, updated_at = ?
     WHERE id = ? AND deleted_at IS NULL`,
  ).run(error, next, now, id);
}

export function releaseStuckBusinessSouls(
  db: Database,
  thresholdMs: number,
  now: number = Date.now(),
): number[] {
  const cutoff = now - thresholdMs;
  return (
    db
      .prepare(
        `UPDATE businesses
           SET soul_status = 'idle', soul_error = NULL, soul_refreshing_at = NULL,
               updated_at = ?
         WHERE soul_status = 'refreshing'
           AND soul_refreshing_at IS NOT NULL
           AND soul_refreshing_at < ?
         RETURNING id`,
      )
      .all(now, cutoff) as Array<{ id: number }>
  ).map((r) => r.id);
}

export function listBusinessSoulRefreshCandidates(
  db: Database,
  opts: { project?: string; limit: number; now?: number } = { limit: 5 },
): Business[] {
  const now = opts.now ?? Date.now();
  const where = ["deleted_at IS NULL", "soul_status = 'idle'"];
  const params: (string | number)[] = [];
  if (opts.project) {
    where.push("project = ?");
    params.push(opts.project);
  }
  where.push("(soul_next_refresh_at IS NULL OR soul_next_refresh_at <= ?)");
  params.push(now);
  // Need at least one signal to scrape: a website or non-empty socials.
  where.push(
    "(website IS NOT NULL OR (socials IS NOT NULL AND socials != '[]'))",
  );
  params.push(opts.limit);
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLS} FROM businesses
       WHERE ${where.join(" AND ")}
       ORDER BY (soul_refreshed_at IS NULL) DESC, COALESCE(soul_refreshed_at, 0) ASC
       LIMIT ?`,
    )
    .all(...params) as BusinessRow[];
  return rows.map(rowToBusiness);
}
