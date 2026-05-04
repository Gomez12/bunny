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
import { registerTrashable, softDelete } from "./trash.ts";

export const CONTACT_KIND: TranslatableKind = {
  name: "contact",
  entityTable: "contacts",
  sidecarTable: "contact_translations",
  entityFk: "contact_id",
  // `soul` is translated alongside `notes` (ADR 0036). The auto-refresh
  // handler decides per call whether to mark stale, gated by cfg.contacts.translateSoul.
  sourceFields: ["notes", "soul"],
  sidecarFields: ["notes", "soul"],
  aliveFilter: "deleted_at IS NULL",
};
registerKind(CONTACT_KIND);

registerTrashable({
  kind: "contact",
  table: "contacts",
  nameColumn: "name",
  hasUniqueName: false,
  translationSidecarTable: "contact_translations",
  translationSidecarFk: "contact_id",
});

function resolveOriginalLangForContact(
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

export type SoulStatus = "idle" | "refreshing" | "error";

/**
 * One social-media handle. `platform` is a free-form lowercase tag matched
 * against `SOCIAL_PLATFORMS` for UI rendering; `handle` is the user-facing
 * identifier (e.g. "@anthropicai" or "alice"); `url` is optional and, when
 * present, takes precedence over the synthesised platform URL in the UI.
 */
export interface SocialHandle {
  platform: string;
  handle: string;
  url?: string;
}

/** Whitelist of known platforms — others get the generic "link" icon. */
export const SOCIAL_PLATFORMS = [
  "twitter",
  "x",
  "linkedin",
  "github",
  "mastodon",
  "instagram",
  "youtube",
  "tiktok",
  "bluesky",
  "facebook",
  "website",
  "other",
] as const;

export interface SoulSource {
  url: string;
  fetchedAt: number;
}

export interface Contact {
  id: number;
  project: string;
  name: string;
  emails: string[];
  phones: string[];
  company: string;
  title: string;
  notes: string;
  avatar: string | null;
  tags: string[];
  socials: SocialHandle[];
  soul: string;
  soulStatus: SoulStatus;
  soulError: string | null;
  soulRefreshedAt: number | null;
  soulRefreshingAt: number | null;
  soulManualEditedAt: number | null;
  soulNextRefreshAt: number | null;
  soulSources: SoulSource[];
  groups: number[];
  businessIds: number[];
  originalLang: string | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ContactGroup {
  id: number;
  project: string;
  name: string;
  color: string | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
  memberCount: number;
}

interface ContactRow {
  id: number;
  project: string;
  name: string;
  emails: string;
  phones: string;
  company: string;
  title: string;
  notes: string;
  avatar: string | null;
  tags: string;
  socials: string;
  soul: string;
  soul_status: string;
  soul_error: string | null;
  soul_refreshed_at: number | null;
  soul_refreshing_at: number | null;
  soul_manual_edited_at: number | null;
  soul_next_refresh_at: number | null;
  soul_sources: string | null;
  original_lang: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

interface GroupRow {
  id: number;
  project: string;
  name: string;
  color: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

/** JSON-array of strings → string[]; null / malformed / non-array all yield []. */
export function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr)
      ? arr.filter((v): v is string => typeof v === "string")
      : [];
  } catch {
    return [];
  }
}

/** Lenient JSON.parse that swallows the SyntaxError and returns null. */
export function safeJsonParse(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseSocials(raw: string | null | undefined): SocialHandle[] {
  return validateSocials(safeJsonParse(raw) ?? []);
}

export function parseSoulSources(raw: string | null | undefined): SoulSource[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(
        (v): v is { url: unknown; fetchedAt?: unknown; fetched_at?: unknown } =>
          v !== null && typeof v === "object",
      )
      .map((v) => ({
        url: typeof v.url === "string" ? v.url : "",
        fetchedAt:
          typeof v.fetchedAt === "number"
            ? v.fetchedAt
            : typeof v.fetched_at === "number"
              ? v.fetched_at
              : 0,
      }))
      .filter((s) => s.url);
  } catch {
    return [];
  }
}

/**
 * Sanitise an arbitrary input array into well-formed `SocialHandle[]`.
 * Returns an empty array for non-arrays. Drops entries with neither a handle
 * nor a URL. Lowercases / trims `platform` so the UI can switch on a fixed
 * vocabulary without surprises.
 */
export function validateSocials(input: unknown): SocialHandle[] {
  if (!Array.isArray(input)) return [];
  const out: SocialHandle[] = [];
  for (const v of input) {
    if (!v || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    const rawPlatform = o["platform"];
    const platform =
      typeof rawPlatform === "string"
        ? rawPlatform.toLowerCase().trim() || "other"
        : "other";
    const rawHandle = o["handle"];
    const handle = typeof rawHandle === "string" ? rawHandle.trim() : "";
    const rawUrl = o["url"];
    const url = typeof rawUrl === "string" ? rawUrl.trim() : undefined;
    if (!handle && !url) continue;
    out.push(url ? { platform, handle, url } : { platform, handle });
  }
  return out;
}

export function normaliseSoulStatus(raw: string): SoulStatus {
  return raw === "refreshing" || raw === "error" ? raw : "idle";
}

function rowToContact(
  r: ContactRow,
  groups: number[] = [],
  businessIds: number[] = [],
): Contact {
  return {
    id: r.id,
    project: r.project,
    name: r.name,
    emails: parseJsonArray(r.emails),
    phones: parseJsonArray(r.phones),
    company: r.company,
    title: r.title,
    notes: r.notes,
    avatar: r.avatar,
    tags: parseJsonArray(r.tags),
    socials: parseSocials(r.socials),
    soul: r.soul,
    soulStatus: normaliseSoulStatus(r.soul_status),
    soulError: r.soul_error,
    soulRefreshedAt: r.soul_refreshed_at,
    soulRefreshingAt: r.soul_refreshing_at,
    soulManualEditedAt: r.soul_manual_edited_at,
    soulNextRefreshAt: r.soul_next_refresh_at,
    soulSources: parseSoulSources(r.soul_sources),
    groups,
    businessIds,
    originalLang: r.original_lang,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const SELECT_COLS = `id, project, name, emails, phones, company, title, notes,
                     avatar, tags, socials, soul, soul_status, soul_error,
                     soul_refreshed_at, soul_refreshing_at, soul_manual_edited_at,
                     soul_next_refresh_at, soul_sources,
                     original_lang, created_by, created_at, updated_at`;

/**
 * Slim projection for `listContacts` — `c.` alias matches `buildContactWhere`.
 * Substitutes empty literals for `notes`, `soul`, `soul_sources` so list
 * payloads stay small (none of those fields render in the grid view).
 */
const SELECT_COLS_LIST_C = `c.id, c.project, c.name, c.emails, c.phones,
                            c.company, c.title, '' AS notes, c.avatar, c.tags,
                            c.socials, '' AS soul, c.soul_status, c.soul_error,
                            c.soul_refreshed_at, c.soul_refreshing_at,
                            c.soul_manual_edited_at, c.soul_next_refresh_at,
                            NULL AS soul_sources,
                            c.original_lang, c.created_by, c.created_at, c.updated_at`;

function batchGetGroupIds(
  db: Database,
  contactIds: number[],
): Map<number, number[]> {
  if (contactIds.length === 0) return new Map();
  const placeholders = contactIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT contact_id, group_id FROM contact_group_members WHERE contact_id IN (${placeholders})`,
    )
    .all(...contactIds) as Array<{ contact_id: number; group_id: number }>;
  const map = new Map<number, number[]>();
  for (const r of rows) {
    const list = map.get(r.contact_id);
    if (list) list.push(r.group_id);
    else map.set(r.contact_id, [r.group_id]);
  }
  return map;
}

function getGroupIds(db: Database, contactId: number): number[] {
  const rows = db
    .prepare(`SELECT group_id FROM contact_group_members WHERE contact_id = ?`)
    .all(contactId) as Array<{ group_id: number }>;
  return rows.map((r) => r.group_id);
}

function batchGetBusinessIds(
  db: Database,
  contactIds: number[],
): Map<number, number[]> {
  if (contactIds.length === 0) return new Map();
  const placeholders = contactIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT cb.contact_id, cb.business_id
         FROM contact_businesses cb
         JOIN businesses b ON b.id = cb.business_id
        WHERE cb.contact_id IN (${placeholders})
          AND b.deleted_at IS NULL
        ORDER BY cb.is_primary DESC, b.name ASC`,
    )
    .all(...contactIds) as Array<{ contact_id: number; business_id: number }>;
  const map = new Map<number, number[]>();
  for (const r of rows) {
    const list = map.get(r.contact_id);
    if (list) list.push(r.business_id);
    else map.set(r.contact_id, [r.business_id]);
  }
  return map;
}

function getBusinessIdsForContact(db: Database, contactId: number): number[] {
  const rows = db
    .prepare(
      `SELECT cb.business_id
         FROM contact_businesses cb
         JOIN businesses b ON b.id = cb.business_id
        WHERE cb.contact_id = ? AND b.deleted_at IS NULL
        ORDER BY cb.is_primary DESC, b.name ASC`,
    )
    .all(contactId) as Array<{ business_id: number }>;
  return rows.map((r) => r.business_id);
}

export interface ContactBusinessLink {
  businessId: number;
  contactId: number;
  role: string | null;
  isPrimary: boolean;
  createdAt: number;
}

interface ContactBusinessRow {
  contact_id: number;
  business_id: number;
  role: string | null;
  is_primary: number;
  created_at: number;
}

function rowToLink(r: ContactBusinessRow): ContactBusinessLink {
  return {
    contactId: r.contact_id,
    businessId: r.business_id,
    role: r.role,
    isPrimary: r.is_primary === 1,
    createdAt: r.created_at,
  };
}

export function listContactBusinessLinks(
  db: Database,
  contactId: number,
): ContactBusinessLink[] {
  const rows = db
    .prepare(
      `SELECT cb.contact_id, cb.business_id, cb.role, cb.is_primary, cb.created_at
         FROM contact_businesses cb
         JOIN businesses b ON b.id = cb.business_id
        WHERE cb.contact_id = ? AND b.deleted_at IS NULL
        ORDER BY cb.is_primary DESC, b.name ASC`,
    )
    .all(contactId) as ContactBusinessRow[];
  return rows.map(rowToLink);
}

/**
 * Same shape as `listContactBusinessLinks` but JOINs the business name +
 * domain in one query so the lookup_contact tool doesn't fan out N point
 * fetches per linked business.
 */
export interface ContactBusinessSummary extends ContactBusinessLink {
  businessName: string;
  businessDomain: string | null;
}

export function listContactBusinessSummaries(
  db: Database,
  contactId: number,
): ContactBusinessSummary[] {
  const rows = db
    .prepare(
      `SELECT cb.contact_id, cb.business_id, cb.role, cb.is_primary, cb.created_at,
              b.name AS business_name, b.domain AS business_domain
         FROM contact_businesses cb
         JOIN businesses b ON b.id = cb.business_id
        WHERE cb.contact_id = ? AND b.deleted_at IS NULL
        ORDER BY cb.is_primary DESC, b.name ASC`,
    )
    .all(contactId) as Array<
    ContactBusinessRow & {
      business_name: string;
      business_domain: string | null;
    }
  >;
  return rows.map((r) => ({
    ...rowToLink(r),
    businessName: r.business_name,
    businessDomain: r.business_domain,
  }));
}

export function listBusinessContactLinks(
  db: Database,
  businessId: number,
): ContactBusinessLink[] {
  const rows = db
    .prepare(
      `SELECT cb.contact_id, cb.business_id, cb.role, cb.is_primary, cb.created_at
         FROM contact_businesses cb
         JOIN contacts c ON c.id = cb.contact_id
        WHERE cb.business_id = ? AND c.deleted_at IS NULL
        ORDER BY cb.is_primary DESC, c.name ASC`,
    )
    .all(businessId) as ContactBusinessRow[];
  return rows.map(rowToLink);
}

export interface BusinessContactSummary extends ContactBusinessLink {
  contactName: string;
}

export function listBusinessContactSummaries(
  db: Database,
  businessId: number,
): BusinessContactSummary[] {
  const rows = db
    .prepare(
      `SELECT cb.contact_id, cb.business_id, cb.role, cb.is_primary, cb.created_at,
              c.name AS contact_name
         FROM contact_businesses cb
         JOIN contacts c ON c.id = cb.contact_id
        WHERE cb.business_id = ? AND c.deleted_at IS NULL
        ORDER BY cb.is_primary DESC, c.name ASC`,
    )
    .all(businessId) as Array<ContactBusinessRow & { contact_name: string }>;
  return rows.map((r) => ({
    ...rowToLink(r),
    contactName: r.contact_name,
  }));
}

export interface LinkContactBusinessOpts {
  role?: string | null;
  isPrimary?: boolean;
}

export function linkContactBusiness(
  db: Database,
  contactId: number,
  businessId: number,
  opts: LinkContactBusinessOpts = {},
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO contact_businesses(contact_id, business_id, role, is_primary, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(contact_id, business_id) DO UPDATE SET
       role = excluded.role,
       is_primary = excluded.is_primary`,
  ).run(contactId, businessId, opts.role ?? null, opts.isPrimary ? 1 : 0, now);
}

export function unlinkContactBusiness(
  db: Database,
  contactId: number,
  businessId: number,
): void {
  db.prepare(
    `DELETE FROM contact_businesses WHERE contact_id = ? AND business_id = ?`,
  ).run(contactId, businessId);
}

// ── Shared WHERE clause builder ──────────────────────────────────────────────

interface FilterOpts {
  search?: string;
  groupId?: number;
}

function buildContactWhere(
  project: string,
  opts?: FilterOpts,
): { where: string; params: (string | number)[] } {
  const conditions = ["c.project = ?", "c.deleted_at IS NULL"];
  const params: (string | number)[] = [project];

  if (opts?.groupId !== undefined) {
    conditions.push(
      "EXISTS (SELECT 1 FROM contact_group_members cgm WHERE cgm.contact_id = c.id AND cgm.group_id = ?)",
    );
    params.push(opts.groupId);
  }

  if (opts?.search) {
    const q = `%${opts.search}%`;
    conditions.push(
      "(c.name LIKE ? OR c.emails LIKE ? OR c.phones LIKE ? OR c.company LIKE ? OR c.tags LIKE ?)",
    );
    params.push(q, q, q, q, q);
  }

  return { where: conditions.join(" AND "), params };
}

// ── Contact CRUD ─────────────────────────────────────────────────────────────

export interface ListContactsOpts extends FilterOpts {
  limit?: number;
  offset?: number;
}

export function listContacts(
  db: Database,
  project: string,
  opts?: ListContactsOpts,
): { contacts: Contact[]; total: number } {
  const { where, params } = buildContactWhere(project, opts);
  const countParams = [...params];

  let sql = `SELECT ${SELECT_COLS_LIST_C} FROM contacts c WHERE ${where} ORDER BY c.name ASC`;

  if (opts?.limit !== undefined) {
    sql += ` LIMIT ?`;
    params.push(opts.limit);
    if (opts?.offset !== undefined) {
      sql += ` OFFSET ?`;
      params.push(opts.offset);
    }
  }

  const rows = db.prepare(sql).all(...params) as ContactRow[];
  const ids = rows.map((r) => r.id);
  const groupMap = batchGetGroupIds(db, ids);
  const businessMap = batchGetBusinessIds(db, ids);
  const contacts = rows.map((r) =>
    rowToContact(r, groupMap.get(r.id) ?? [], businessMap.get(r.id) ?? []),
  );

  const countRow = db
    .prepare(`SELECT COUNT(*) AS cnt FROM contacts c WHERE ${where}`)
    .get(...countParams) as { cnt: number };

  return { contacts, total: countRow.cnt };
}

export function getContact(db: Database, id: number): Contact | null {
  const row = db
    .prepare(
      `SELECT ${SELECT_COLS} FROM contacts WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(id) as ContactRow | undefined;
  if (!row) return null;
  return rowToContact(
    row,
    getGroupIds(db, id),
    getBusinessIdsForContact(db, id),
  );
}

export interface CreateContactOpts {
  project: string;
  name: string;
  emails?: string[];
  phones?: string[];
  company?: string;
  title?: string;
  notes?: string;
  avatar?: string | null;
  tags?: string[];
  socials?: SocialHandle[];
  groups?: number[];
  originalLang?: string;
  createdBy: string;
}

export function createContact(db: Database, opts: CreateContactOpts): Contact {
  const name = opts.name.trim();
  if (!name) throw new Error("contact name is required");
  const now = Date.now();
  const originalLang = resolveOriginalLangForContact(
    db,
    opts.project,
    opts.originalLang,
  );
  const socials = validateSocials(opts.socials ?? []);

  const info = db
    .prepare(
      `INSERT INTO contacts(project, name, emails, phones, company, title, notes,
                             avatar, tags, socials, original_lang, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.project,
      name,
      JSON.stringify(opts.emails ?? []),
      JSON.stringify(opts.phones ?? []),
      opts.company ?? "",
      opts.title ?? "",
      opts.notes ?? "",
      opts.avatar ?? null,
      JSON.stringify(opts.tags ?? []),
      JSON.stringify(socials),
      originalLang,
      opts.createdBy,
      now,
      now,
    );

  const contactId = Number(info.lastInsertRowid);
  if (opts.groups?.length) {
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO contact_group_members(group_id, contact_id) VALUES (?, ?)`,
    );
    for (const gid of opts.groups) stmt.run(gid, contactId);
  }
  createTranslationSlots(db, CONTACT_KIND, contactId);
  return getContact(db, contactId)!;
}

export interface UpdateContactPatch {
  name?: string;
  emails?: string[];
  phones?: string[];
  company?: string;
  title?: string;
  notes?: string;
  avatar?: string | null;
  tags?: string[];
  socials?: SocialHandle[];
  groups?: number[];
}

export function updateContact(
  db: Database,
  id: number,
  patch: UpdateContactPatch,
): Contact {
  const existing = getContact(db, id);
  if (!existing) throw new Error(`contact ${id} not found`);

  const name = patch.name === undefined ? existing.name : patch.name.trim();
  if (!name) throw new Error("contact name is required");

  const emails = patch.emails ?? existing.emails;
  const phones = patch.phones ?? existing.phones;
  const company = patch.company ?? existing.company;
  const title = patch.title ?? existing.title;
  const notes = patch.notes ?? existing.notes;
  const avatar = patch.avatar === undefined ? existing.avatar : patch.avatar;
  const tags = patch.tags ?? existing.tags;
  const socials =
    patch.socials === undefined
      ? existing.socials
      : validateSocials(patch.socials);
  const now = Date.now();

  db.prepare(
    `UPDATE contacts
     SET name = ?, emails = ?, phones = ?, company = ?, title = ?, notes = ?,
         avatar = ?, tags = ?, socials = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    name,
    JSON.stringify(emails),
    JSON.stringify(phones),
    company,
    title,
    notes,
    avatar,
    JSON.stringify(tags),
    JSON.stringify(socials),
    now,
    id,
  );

  // Notes is a translated source field — same as before. Soul changes go
  // through `setContactSoulManual` / `setContactSoulAuto`, which call the
  // stale-marker themselves (gated by the translateSoul cfg knob).
  if (notes !== existing.notes) markTranslationsStale(db, CONTACT_KIND, id);

  let groups = existing.groups;
  if (patch.groups !== undefined) {
    db.prepare(`DELETE FROM contact_group_members WHERE contact_id = ?`).run(
      id,
    );
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO contact_group_members(group_id, contact_id) VALUES (?, ?)`,
    );
    for (const gid of patch.groups) stmt.run(gid, id);
    groups = patch.groups;
  }

  return {
    ...existing,
    name,
    emails,
    phones,
    company,
    title,
    notes,
    avatar,
    tags,
    socials,
    groups,
    updatedAt: now,
  };
}

/**
 * Group memberships stay in place on soft-delete so restore fully reinstates
 * them; the cascade FK drops them only on hard-delete from the Trash tab.
 */
export function deleteContact(
  db: Database,
  id: number,
  deletedBy: string | null = null,
): void {
  softDelete(db, "contact", id, deletedBy);
}

export function bulkCreateContacts(
  db: Database,
  project: string,
  contacts: Omit<CreateContactOpts, "project" | "createdBy">[],
  createdBy: string,
): number {
  const insertContact = db.prepare(
    `INSERT INTO contacts(project, name, emails, phones, company, title, notes,
                           avatar, tags, socials, original_lang, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertGroup = db.prepare(
    `INSERT OR IGNORE INTO contact_group_members(group_id, contact_id) VALUES (?, ?)`,
  );
  const projectDefaultLang = resolveOriginalLangForContact(
    db,
    project,
    undefined,
  );

  const tx = db.transaction(() => {
    const now = Date.now();
    for (const c of contacts) {
      const name = (c.name ?? "").trim();
      if (!name) continue;
      const info = insertContact.run(
        project,
        name,
        JSON.stringify(c.emails ?? []),
        JSON.stringify(c.phones ?? []),
        c.company ?? "",
        c.title ?? "",
        c.notes ?? "",
        c.avatar ?? null,
        JSON.stringify(c.tags ?? []),
        JSON.stringify(validateSocials(c.socials ?? [])),
        c.originalLang ?? projectDefaultLang,
        createdBy,
        now,
        now,
      );
      const contactId = Number(info.lastInsertRowid);
      if (c.groups?.length) {
        for (const gid of c.groups) insertGroup.run(gid, contactId);
      }
      createTranslationSlots(db, CONTACT_KIND, contactId);
    }
    return contacts.length;
  });
  return tx();
}

export function canEditContact(
  user: User,
  contact: Contact,
  project: Project,
): boolean {
  if (user.role === "admin") return true;
  if (project.createdBy && project.createdBy === user.id) return true;
  if (contact.createdBy === user.id) return true;
  return false;
}

// ── Per-contact soul (LLM-curated, periodically refreshed) ───────────────────

/**
 * Replace the soul body via the manual-edit affordance. Stamps
 * `soul_manual_edited_at` so the next auto-refresh treats the user-supplied
 * seed as authoritative until contradicted. Throws when the input exceeds the
 * field cap. When `markStale` is true the row's translation slots are flipped
 * to pending — only callers that own the cfg.contacts.translateSoul knob
 * should pass true.
 */
export function setContactSoulManual(
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
    `UPDATE contacts
       SET soul = ?, soul_manual_edited_at = ?, updated_at = ?
     WHERE id = ? AND deleted_at IS NULL`,
  ).run(soul, now, now, id);
  if (opts.markStale) markTranslationsStale(db, CONTACT_KIND, id);
}

/**
 * Persist an auto-refreshed soul + its source list, advance the next-refresh
 * cadence, and flip the row back to `idle`. Truncates if the model returned
 * more than the budget.
 */
export function setContactSoulAuto(
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
    `UPDATE contacts
       SET soul = ?, soul_sources = ?, soul_status = 'idle', soul_error = NULL,
           soul_refreshing_at = NULL, soul_refreshed_at = ?, soul_next_refresh_at = ?,
           updated_at = ?
     WHERE id = ? AND deleted_at IS NULL`,
  ).run(trimmed, JSON.stringify(sources), now, next, now, id);
  if (opts.markStale) markTranslationsStale(db, CONTACT_KIND, id);
}

/**
 * Atomically flip the row to `'refreshing'`. Returns false when another
 * tick already owns it.
 */
export function claimContactSoulRefresh(
  db: Database,
  id: number,
  now: number = Date.now(),
): boolean {
  const info = db
    .prepare(
      `UPDATE contacts
         SET soul_status = 'refreshing', soul_refreshing_at = ?, soul_error = NULL, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL AND soul_status != 'refreshing'`,
    )
    .run(now, now, id);
  return info.changes > 0;
}

export function setContactSoulError(
  db: Database,
  id: number,
  error: string,
  cadenceMs: number = ENTITY_SOUL_DEFAULT_CADENCE_MS,
): void {
  const now = Date.now();
  // Park the next attempt one cadence out so a flapping target doesn't pin
  // an LLM call slot every tick.
  const next = now + cadenceMs;
  db.prepare(
    `UPDATE contacts
       SET soul_status = 'error', soul_error = ?, soul_refreshing_at = NULL,
           soul_next_refresh_at = ?, updated_at = ?
     WHERE id = ? AND deleted_at IS NULL`,
  ).run(error, next, now, id);
}

/**
 * Reclaim rows stuck in `'refreshing'` for longer than `thresholdMs`. Returns
 * the contact ids that were reset so the caller can log them.
 */
export function releaseStuckContactSouls(
  db: Database,
  thresholdMs: number,
  now: number = Date.now(),
): number[] {
  const cutoff = now - thresholdMs;
  return (
    db
      .prepare(
        `UPDATE contacts
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

/**
 * Return contact ids ready for a soul-refresh tick. Selects rows that:
 *  - have at least one social handle or a website (input source for the LLM),
 *  - are `soul_status='idle'`,
 *  - never refreshed yet, OR `soul_next_refresh_at <= now`.
 *
 * Sorted: never-refreshed first, then oldest `soul_refreshed_at`. The caller
 * still races the row via `claimContactSoulRefresh` before billing the LLM.
 */
export function listContactSoulRefreshCandidates(
  db: Database,
  opts: { project?: string; limit: number; now?: number } = { limit: 5 },
): Contact[] {
  const now = opts.now ?? Date.now();
  const where = ["c.deleted_at IS NULL", "c.soul_status = 'idle'"];
  const params: (string | number)[] = [];
  if (opts.project) {
    where.push("c.project = ?");
    params.push(opts.project);
  }
  where.push("(c.soul_next_refresh_at IS NULL OR c.soul_next_refresh_at <= ?)");
  params.push(now);
  // Need at least one social handle (socials JSON is more than '[]') OR a
  // non-empty website (heuristic via socials with platform=website handled
  // there already; we accept either condition).
  where.push("c.socials IS NOT NULL AND c.socials != '[]'");
  params.push(opts.limit);
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLS.split(",")
        .map((c) => "c." + c.trim())
        .join(", ")} FROM contacts c
       WHERE ${where.join(" AND ")}
       ORDER BY (c.soul_refreshed_at IS NULL) DESC, COALESCE(c.soul_refreshed_at, 0) ASC
       LIMIT ?`,
    )
    .all(...params) as ContactRow[];
  return rows.map((r) => rowToContact(r, [], []));
}

// ── Contact Group CRUD ───────────────────────────────────────────────────────

export function listGroups(db: Database, project: string): ContactGroup[] {
  const rows = db
    .prepare(
      `SELECT g.*, COALESCE(m.cnt, 0) AS member_count
       FROM contact_groups g
       LEFT JOIN (
         SELECT cgm.group_id, COUNT(*) AS cnt
           FROM contact_group_members cgm
           JOIN contacts c ON c.id = cgm.contact_id
          WHERE c.deleted_at IS NULL
          GROUP BY cgm.group_id
       ) m ON m.group_id = g.id
       WHERE g.project = ?
       ORDER BY g.name ASC`,
    )
    .all(project) as Array<GroupRow & { member_count: number }>;
  return rows.map((r) => ({
    id: r.id,
    project: r.project,
    name: r.name,
    color: r.color,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    memberCount: r.member_count,
  }));
}

export function getGroup(db: Database, id: number): ContactGroup | null {
  const row = db
    .prepare(
      `SELECT g.*, COALESCE(m.cnt, 0) AS member_count
       FROM contact_groups g
       LEFT JOIN (
         SELECT cgm.group_id, COUNT(*) AS cnt
           FROM contact_group_members cgm
           JOIN contacts c ON c.id = cgm.contact_id
          WHERE c.deleted_at IS NULL
          GROUP BY cgm.group_id
       ) m ON m.group_id = g.id
       WHERE g.id = ?`,
    )
    .get(id) as (GroupRow & { member_count: number }) | undefined;
  if (!row) return null;
  return {
    id: row.id,
    project: row.project,
    name: row.name,
    color: row.color,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    memberCount: row.member_count,
  };
}

export interface CreateGroupOpts {
  project: string;
  name: string;
  color?: string | null;
  createdBy: string;
}

export function createGroup(db: Database, opts: CreateGroupOpts): ContactGroup {
  const name = opts.name.trim();
  if (!name) throw new Error("group name is required");
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO contact_groups(project, name, color, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(opts.project, name, opts.color ?? null, opts.createdBy, now, now);
  return getGroup(db, Number(info.lastInsertRowid))!;
}

export interface UpdateGroupPatch {
  name?: string;
  color?: string | null;
}

export function updateGroup(
  db: Database,
  id: number,
  patch: UpdateGroupPatch,
): ContactGroup {
  const existing = getGroup(db, id);
  if (!existing) throw new Error(`contact group ${id} not found`);

  const name = patch.name === undefined ? existing.name : patch.name.trim();
  if (!name) throw new Error("group name is required");
  const color = patch.color === undefined ? existing.color : patch.color;

  db.prepare(
    `UPDATE contact_groups SET name = ?, color = ?, updated_at = ? WHERE id = ?`,
  ).run(name, color, Date.now(), id);
  return getGroup(db, id)!;
}

export function deleteGroup(db: Database, id: number): void {
  db.prepare(`DELETE FROM contact_group_members WHERE group_id = ?`).run(id);
  db.prepare(`DELETE FROM contact_groups WHERE id = ?`).run(id);
}

// ── vCard export ─────────────────────────────────────────────────────────────

export function contactToVCard(c: Contact): string {
  const lines = ["BEGIN:VCARD", "VERSION:3.0", `FN:${c.name}`];
  for (const email of c.emails) lines.push(`EMAIL:${email}`);
  for (const phone of c.phones) lines.push(`TEL:${phone}`);
  if (c.company) lines.push(`ORG:${c.company}`);
  if (c.title) lines.push(`TITLE:${c.title}`);
  for (const s of c.socials) {
    const target = s.url || s.handle;
    if (!target) continue;
    if (s.platform === "website") {
      lines.push(`URL:${target}`);
    } else {
      lines.push(`X-SOCIALPROFILE;type=${s.platform}:${target}`);
    }
  }
  if (c.notes) lines.push(`NOTE:${c.notes.replace(/\n/g, "\\n")}`);
  lines.push("END:VCARD");
  return lines.join("\r\n");
}

export function contactsToVCard(contacts: Contact[]): string {
  return contacts.map(contactToVCard).join("\r\n");
}
