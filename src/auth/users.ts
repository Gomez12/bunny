/**
 * User persistence — CRUD against the `users` table.
 */

import type { Database } from "bun:sqlite";
import { hashPassword } from "./password.ts";
import { MEMORY_FIELD_CHAR_LIMIT } from "../memory/memory_constants.ts";

export type UserRole = "admin" | "user";

/** Status of the per-user soul-refresh state machine. */
export type SoulStatus = "idle" | "refreshing" | "error";

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
  /**
   * Free-text personality + style + demographics. Auto-curated hourly; max
   * 4 000 chars. Optional in the type only — `rowToUser` always populates it
   * (DB column is `NOT NULL DEFAULT ''`). Test fixtures may omit them.
   */
  soul?: string;
  soulStatus?: SoulStatus;
  soulError?: string | null;
  soulWatermarkMessageId?: number;
  soulRefreshedAt?: number | null;
  soulRefreshingAt?: number | null;
  soulManualEditedAt?: number | null;
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
  soul: string | null;
  soul_status: string | null;
  soul_error: string | null;
  soul_watermark_message_id: number | null;
  soul_refreshed_at: number | null;
  soul_refreshing_at: number | null;
  soul_manual_edited_at: number | null;
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

function normaliseSoulStatus(raw: string | null | undefined): SoulStatus {
  return raw === "refreshing" || raw === "error" ? raw : "idle";
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
    soul: r.soul ?? "",
    soulStatus: normaliseSoulStatus(r.soul_status),
    soulError: r.soul_error ?? null,
    soulWatermarkMessageId: r.soul_watermark_message_id ?? 0,
    soulRefreshedAt: r.soul_refreshed_at ?? null,
    soulRefreshingAt: r.soul_refreshing_at ?? null,
    soulManualEditedAt: r.soul_manual_edited_at ?? null,
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
    soul: "",
    soulStatus: "idle",
    soulError: null,
    soulWatermarkMessageId: 0,
    soulRefreshedAt: null,
    soulRefreshingAt: null,
    soulManualEditedAt: null,
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

// ── Soul (per-user personality) ──────────────────────────────────────────────

/**
 * Replace the soul body via the manual-edit affordance. Stamps
 * `soul_manual_edited_at` so the next auto-refresh treats the new value as a
 * trustworthy seed. Throws when the input exceeds the field cap.
 */
export function setUserSoulManual(
  db: Database,
  id: string,
  soul: string,
): User | null {
  if (soul.length > MEMORY_FIELD_CHAR_LIMIT) {
    throw new Error(
      `soul exceeds ${MEMORY_FIELD_CHAR_LIMIT}-char cap (got ${soul.length})`,
    );
  }
  const now = Date.now();
  const info = db
    .prepare(
      `UPDATE users
       SET soul = ?, soul_manual_edited_at = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(soul, now, now, id);
  if (info.changes === 0) return null;
  return getUserById(db, id);
}

/**
 * Persist the LLM-merged soul and advance the watermark. Truncates if the
 * model overshot the budget; never stores more than the cap.
 */
export function setUserSoulAuto(
  db: Database,
  id: string,
  soul: string,
  watermarkMessageId: number,
): User | null {
  const trimmed =
    soul.length > MEMORY_FIELD_CHAR_LIMIT
      ? soul.slice(0, MEMORY_FIELD_CHAR_LIMIT)
      : soul;
  const now = Date.now();
  const info = db
    .prepare(
      `UPDATE users
       SET soul = ?, soul_watermark_message_id = ?, soul_status = 'idle',
           soul_error = NULL, soul_refreshing_at = NULL,
           soul_refreshed_at = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(trimmed, watermarkMessageId, now, now, id);
  if (info.changes === 0) return null;
  return getUserById(db, id);
}

/** Advance the watermark only — no body change (e.g. nothing new to learn). */
export function bumpUserSoulWatermark(
  db: Database,
  id: string,
  watermarkMessageId: number,
): void {
  const now = Date.now();
  db.prepare(
    `UPDATE users
     SET soul_watermark_message_id = ?, soul_status = 'idle',
         soul_error = NULL, soul_refreshing_at = NULL,
         soul_refreshed_at = ?, updated_at = ?
     WHERE id = ?`,
  ).run(watermarkMessageId, now, now, id);
}

/**
 * Atomically claim the user's soul row for this tick. Returns false when
 * another tick is already refreshing it, so callers can move on.
 */
export function claimUserSoulForRefresh(
  db: Database,
  id: string,
  now: number = Date.now(),
): boolean {
  const info = db
    .prepare(
      `UPDATE users
       SET soul_status = 'refreshing', soul_refreshing_at = ?,
           soul_error = NULL, updated_at = ?
       WHERE id = ? AND soul_status != 'refreshing'`,
    )
    .run(now, now, id);
  return info.changes > 0;
}

export function setUserSoulError(
  db: Database,
  id: string,
  error: string,
): void {
  const now = Date.now();
  db.prepare(
    `UPDATE users
     SET soul_status = 'error', soul_error = ?, soul_refreshing_at = NULL,
         updated_at = ?
     WHERE id = ?`,
  ).run(error, now, id);
}

/** Reclaim user.soul rows stuck in `'refreshing'` longer than `thresholdMs`. */
export function releaseStuckUserSoul(
  db: Database,
  thresholdMs: number,
  now: number = Date.now(),
): string[] {
  const cutoff = now - thresholdMs;
  return (
    db
      .prepare(
        `UPDATE users
         SET soul_status = 'idle', soul_error = NULL, soul_refreshing_at = NULL,
             updated_at = ?
         WHERE soul_status = 'refreshing'
           AND soul_refreshing_at IS NOT NULL
           AND soul_refreshing_at < ?
         RETURNING id`,
      )
      .all(now, cutoff) as Array<{ id: string }>
  ).map((r) => r.id);
}

/**
 * List users with `soul_status='idle'`, ordered by oldest soul refresh first.
 * Used by the hourly refresh handler to walk every user once per cycle.
 */
export function listUserSoulRefreshCandidates(
  db: Database,
  limit: number,
): User[] {
  const rows = db
    .prepare(
      `SELECT * FROM users
       WHERE soul_status = 'idle'
       ORDER BY COALESCE(soul_refreshed_at, 0) ASC
       LIMIT ?`,
    )
    .all(limit) as UserRow[];
  return rows.map(rowToUser);
}
