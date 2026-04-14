/**
 * API keys for programmatic (CLI / HTTP bearer) access.
 *
 * Key format: `bny_<prefix8>_<secret32>` (ascii, base36-ish from random bytes).
 * Only the sha256 hash of the secret is stored; the plaintext is shown once at
 * creation and never again.
 */

import type { Database } from "bun:sqlite";

const KEY_PREFIX = "bny_";

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface ApiKeyMeta {
  id: string;
  userId: string;
  name: string;
  prefix: string;
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

interface ApiKeyRow {
  id: string;
  user_id: string;
  name: string;
  prefix: string;
  key_hash: string;
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
}

function rowToMeta(r: ApiKeyRow): ApiKeyMeta {
  return {
    id: r.id,
    userId: r.user_id,
    name: r.name,
    prefix: r.prefix,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    lastUsedAt: r.last_used_at,
    revokedAt: r.revoked_at,
  };
}

export interface CreateApiKeyResult {
  meta: ApiKeyMeta;
  /** Plaintext key, shown once. */
  secret: string;
}

export async function createApiKey(
  db: Database,
  userId: string,
  name: string,
  expiresAt: number | null = null,
): Promise<CreateApiKeyResult> {
  const id = crypto.randomUUID();
  const prefix = randomHex(4); // 8 hex chars
  const secretPart = randomHex(16); // 32 hex chars
  const secret = `${KEY_PREFIX}${prefix}_${secretPart}`;
  const keyHash = await sha256Hex(secret);
  const now = Date.now();
  db.prepare(
    `INSERT INTO api_keys (id, user_id, name, key_hash, prefix, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, name, keyHash, prefix, now, expiresAt);
  return {
    meta: {
      id,
      userId,
      name,
      prefix,
      createdAt: now,
      expiresAt,
      lastUsedAt: null,
      revokedAt: null,
    },
    secret,
  };
}

export async function validateApiKey(db: Database, raw: string): Promise<{ userId: string; id: string } | null> {
  if (!raw || !raw.startsWith(KEY_PREFIX)) return null;
  const keyHash = await sha256Hex(raw);
  const row = db
    .prepare(
      `SELECT id, user_id, expires_at, revoked_at FROM api_keys WHERE key_hash = ?`,
    )
    .get(keyHash) as
    | { id: string; user_id: string; expires_at: number | null; revoked_at: number | null }
    | null;
  if (!row) return null;
  if (row.revoked_at !== null) return null;
  if (row.expires_at !== null && row.expires_at < Date.now()) return null;
  db.prepare(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`).run(Date.now(), row.id);
  return { userId: row.user_id, id: row.id };
}

export function listApiKeys(db: Database, userId: string): ApiKeyMeta[] {
  const rows = db
    .prepare(`SELECT * FROM api_keys WHERE user_id = ? ORDER BY created_at DESC`)
    .all(userId) as ApiKeyRow[];
  return rows.map(rowToMeta);
}

export function revokeApiKey(db: Database, id: string, userId: string): boolean {
  const res = db
    .prepare(`UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL`)
    .run(Date.now(), id, userId);
  return (res.changes ?? 0) > 0;
}
