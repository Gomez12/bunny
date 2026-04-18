/**
 * Authentication middleware for HTTP routes.
 *
 * Resolves the caller to a `User` by trying, in order:
 *   1. `Authorization: Bearer bny_...` — API key.
 *   2. `Cookie: bunny_session=<token>` — web session cookie.
 *
 * Returns `null` when the caller cannot be authenticated. Route handlers turn
 * that into a 401 response.
 */

import type { Database } from "bun:sqlite";
import { validateApiKey } from "../auth/apikeys.ts";
import { validateSession } from "../auth/sessions.ts";
import { getUserById, type User } from "../auth/users.ts";

export const SESSION_COOKIE = "bunny_session";

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function getSessionToken(req: Request): string | null {
  const cookies = parseCookies(req.headers.get("cookie"));
  return cookies[SESSION_COOKIE] ?? null;
}

export async function authenticate(
  db: Database,
  req: Request,
): Promise<User | null> {
  const auth = req.headers.get("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) {
    const raw = auth.slice(7).trim();
    const match = await validateApiKey(db, raw);
    if (match) return getUserById(db, match.userId);
  }
  const token = getSessionToken(req);
  if (token) {
    const sess = validateSession(db, token);
    if (sess) return getUserById(db, sess.userId);
  }
  return null;
}

export function setSessionCookieHeader(
  token: string,
  ttlSeconds: number,
): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${ttlSeconds}`;
}

export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}
