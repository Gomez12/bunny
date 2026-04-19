import type { Database } from "bun:sqlite";
import type { User } from "../auth/users.ts";
import type { Project } from "./projects.ts";
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
  sourceFields: ["notes"],
  sidecarFields: ["notes"],
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
  groups: number[];
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

function parseJsonArray(raw: string): string[] {
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr)
      ? arr.filter((v): v is string => typeof v === "string")
      : [];
  } catch {
    return [];
  }
}

function rowToContact(r: ContactRow, groups: number[] = []): Contact {
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
    groups,
    originalLang: r.original_lang,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const SELECT_COLS = `id, project, name, emails, phones, company, title, notes,
                     avatar, tags, original_lang, created_by, created_at, updated_at`;

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

  let sql = `SELECT ${SELECT_COLS.split(",")
    .map((c) => "c." + c.trim())
    .join(", ")} FROM contacts c WHERE ${where} ORDER BY c.name ASC`;

  if (opts?.limit !== undefined) {
    sql += ` LIMIT ?`;
    params.push(opts.limit);
    if (opts?.offset !== undefined) {
      sql += ` OFFSET ?`;
      params.push(opts.offset);
    }
  }

  const rows = db.prepare(sql).all(...params) as ContactRow[];
  const groupMap = batchGetGroupIds(
    db,
    rows.map((r) => r.id),
  );
  const contacts = rows.map((r) => rowToContact(r, groupMap.get(r.id) ?? []));

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
  return rowToContact(row, getGroupIds(db, id));
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

  const info = db
    .prepare(
      `INSERT INTO contacts(project, name, emails, phones, company, title, notes,
                             avatar, tags, original_lang, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  const now = Date.now();

  db.prepare(
    `UPDATE contacts
     SET name = ?, emails = ?, phones = ?, company = ?, title = ?, notes = ?,
         avatar = ?, tags = ?, updated_at = ?
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
    now,
    id,
  );

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
                           avatar, tags, original_lang, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  if (c.notes) lines.push(`NOTE:${c.notes.replace(/\n/g, "\\n")}`);
  lines.push("END:VCARD");
  return lines.join("\r\n");
}

export function contactsToVCard(contacts: Contact[]): string {
  return contacts.map(contactToVCard).join("\r\n");
}
