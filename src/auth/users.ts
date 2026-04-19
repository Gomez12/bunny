/**
 * User persistence — CRUD against the `users` table.
 */

import type { Database } from "bun:sqlite";
import { hashPassword } from "./password.ts";

export type UserRole = "admin" | "user";

export interface User {
  id: string;
  username: string;
  role: UserRole;
  displayName: string | null;
  email: string | null;
  mustChangePassword: boolean;
  expandThinkBubbles: boolean;
  expandToolBubbles: boolean;
  preferredLanguage: string | null;
  createdAt: number;
  updatedAt: number;
}

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: string;
  display_name: string | null;
  email: string | null;
  must_change_pw: number;
  expand_think_bubbles: number;
  expand_tool_bubbles: number;
  preferred_language: string | null;
  created_at: number;
  updated_at: number;
}

const ISO_639_1_RE = /^[a-z]{2}$/;

/** Normalise a preferred-language input. `null` and `""` clear the preference. */
export function normalisePreferredLanguage(
  raw: unknown,
): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw === "") return null;
  if (typeof raw !== "string") {
    throw new Error("preferred_language must be a string");
  }
  const code = raw.toLowerCase();
  if (!ISO_639_1_RE.test(code)) {
    throw new Error(`invalid preferred_language '${raw}' (ISO 639-1 expected)`);
  }
  return code;
}

function rowToUser(r: UserRow): User {
  return {
    id: r.id,
    username: r.username,
    role: (r.role as UserRole) ?? "user",
    displayName: r.display_name,
    email: r.email,
    mustChangePassword: r.must_change_pw === 1,
    expandThinkBubbles: r.expand_think_bubbles === 1,
    expandToolBubbles: r.expand_tool_bubbles === 1,
    preferredLanguage: r.preferred_language,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface CreateUserOpts {
  username: string;
  password: string;
  role?: UserRole;
  displayName?: string | null;
  email?: string | null;
  mustChangePassword?: boolean;
}

export async function createUser(
  db: Database,
  opts: CreateUserOpts,
): Promise<User> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const hash = await hashPassword(opts.password);
  db.prepare(
    `INSERT INTO users (id, username, password_hash, role, display_name, email, must_change_pw, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.username,
    hash,
    opts.role ?? "user",
    opts.displayName ?? null,
    opts.email ?? null,
    opts.mustChangePassword ? 1 : 0,
    now,
    now,
  );
  return {
    id,
    username: opts.username,
    role: opts.role ?? "user",
    displayName: opts.displayName ?? null,
    email: opts.email ?? null,
    mustChangePassword: opts.mustChangePassword ?? false,
    expandThinkBubbles: false,
    expandToolBubbles: false,
    preferredLanguage: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function getUserById(db: Database, id: string): User | null {
  const row = db
    .prepare(`SELECT * FROM users WHERE id = ?`)
    .get(id) as UserRow | null;
  return row ? rowToUser(row) : null;
}

export function getUserByUsername(db: Database, username: string): User | null {
  const row = db
    .prepare(`SELECT * FROM users WHERE username = ?`)
    .get(username) as UserRow | null;
  return row ? rowToUser(row) : null;
}

/**
 * Case-insensitive variant used by the mention scanner — users type `@Alice`
 * without caring about the stored casing. Storage stays as-typed; this only
 * relaxes the lookup.
 */
export function getUserByUsernameCI(
  db: Database,
  username: string,
): User | null {
  const row = db
    .prepare(`SELECT * FROM users WHERE LOWER(username) = LOWER(?)`)
    .get(username) as UserRow | null;
  return row ? rowToUser(row) : null;
}

export function getUserPasswordHash(db: Database, id: string): string | null {
  const row = db
    .prepare(`SELECT password_hash FROM users WHERE id = ?`)
    .get(id) as { password_hash: string } | null;
  return row?.password_hash ?? null;
}

export function countUsers(db: Database): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM users`).get() as {
    n: number;
  };
  return row.n;
}

export function hasAnyUser(db: Database): boolean {
  return db.prepare(`SELECT 1 FROM users LIMIT 1`).get() !== null;
}

export interface ListUsersOpts {
  q?: string;
  limit?: number;
  offset?: number;
}

export function listUsers(db: Database, opts: ListUsersOpts = {}): User[] {
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  if (opts.q && opts.q.trim()) {
    const q = `%${opts.q.trim()}%`;
    const rows = db
      .prepare(
        `SELECT * FROM users
         WHERE username LIKE ? OR display_name LIKE ? OR email LIKE ?
         ORDER BY username ASC LIMIT ? OFFSET ?`,
      )
      .all(q, q, q, limit, offset) as UserRow[];
    return rows.map(rowToUser);
  }
  const rows = db
    .prepare(`SELECT * FROM users ORDER BY username ASC LIMIT ? OFFSET ?`)
    .all(limit, offset) as UserRow[];
  return rows.map(rowToUser);
}

export interface UpdateUserOpts {
  role?: UserRole;
  displayName?: string | null;
  email?: string | null;
  mustChangePassword?: boolean;
  expandThinkBubbles?: boolean;
  expandToolBubbles?: boolean;
  preferredLanguage?: string | null;
}

export function updateUser(
  db: Database,
  id: string,
  opts: UpdateUserOpts,
): User | null {
  const current = getUserById(db, id);
  if (!current) return null;
  const next = {
    role: opts.role ?? current.role,
    displayName:
      opts.displayName === undefined ? current.displayName : opts.displayName,
    email: opts.email === undefined ? current.email : opts.email,
    mustChangePassword:
      opts.mustChangePassword === undefined
        ? current.mustChangePassword
        : opts.mustChangePassword,
    expandThinkBubbles:
      opts.expandThinkBubbles === undefined
        ? current.expandThinkBubbles
        : opts.expandThinkBubbles,
    expandToolBubbles:
      opts.expandToolBubbles === undefined
        ? current.expandToolBubbles
        : opts.expandToolBubbles,
    preferredLanguage:
      opts.preferredLanguage === undefined
        ? current.preferredLanguage
        : opts.preferredLanguage,
  };
  const now = Date.now();
  db.prepare(
    `UPDATE users SET role = ?, display_name = ?, email = ?, must_change_pw = ?,
       expand_think_bubbles = ?, expand_tool_bubbles = ?, preferred_language = ?,
       updated_at = ? WHERE id = ?`,
  ).run(
    next.role,
    next.displayName,
    next.email,
    next.mustChangePassword ? 1 : 0,
    next.expandThinkBubbles ? 1 : 0,
    next.expandToolBubbles ? 1 : 0,
    next.preferredLanguage,
    now,
    id,
  );
  return { ...current, ...next, updatedAt: now };
}

export async function setPassword(
  db: Database,
  id: string,
  plaintext: string,
  mustChange = false,
): Promise<void> {
  const hash = await hashPassword(plaintext);
  db.prepare(
    `UPDATE users SET password_hash = ?, must_change_pw = ?, updated_at = ? WHERE id = ?`,
  ).run(hash, mustChange ? 1 : 0, Date.now(), id);
}

export function deleteUser(db: Database, id: string): void {
  db.prepare(`DELETE FROM users WHERE id = ?`).run(id);
}
