/**
 * Auth + user management HTTP routes. Mounted under `/api/auth/*`,
 * `/api/users/*`, `/api/apikeys/*`. All responses are JSON.
 */

import type { Database } from "bun:sqlite";
import type { BunnyConfig } from "../config.ts";
import type { BunnyQueue } from "../queue/bunqueue.ts";
import type { User, UserRole } from "../auth/users.ts";

import {
  createUser,
  deleteUser,
  getUserById,
  getUserByUsername,
  getUserPasswordHash,
  listUsers,
  normalisePreferredLanguage,
  setPassword,
  updateUser,
} from "../auth/users.ts";
import { verifyPassword } from "../auth/password.ts";
import {
  issueSession,
  revokeSession,
  revokeUserSessions,
} from "../auth/sessions.ts";
import { createApiKey, listApiKeys, revokeApiKey } from "../auth/apikeys.ts";
import {
  authenticate,
  clearSessionCookieHeader,
  getSessionToken,
  setSessionCookieHeader,
} from "./auth_middleware.ts";
import { closeAllFor as closeNotificationFanoutsFor } from "../notifications/fanout.ts";
import { json } from "./http.ts";

function publicUser(u: User) {
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    displayName: u.displayName,
    email: u.email,
    mustChangePassword: u.mustChangePassword,
    expandThinkBubbles: u.expandThinkBubbles,
    expandToolBubbles: u.expandToolBubbles,
    preferredLanguage: u.preferredLanguage,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  };
}

export interface AuthRouteCtx {
  db: Database;
  cfg: BunnyConfig;
  queue: BunnyQueue;
}

/**
 * Entry point. Returns a Response if the path matches an auth route, otherwise
 * `null` so the caller can fall through to the next dispatcher.
 */
export async function handleAuthRoute(
  req: Request,
  url: URL,
  ctx: AuthRouteCtx,
): Promise<Response | null> {
  const { pathname } = url;

  const isAuthPath =
    pathname.startsWith("/api/auth/") ||
    pathname.startsWith("/api/users") ||
    pathname.startsWith("/api/apikeys");
  if (!isAuthPath) return null;

  // ── Public: login ─────────────────────────────────────────────────────────
  if (pathname === "/api/auth/login" && req.method === "POST") {
    return loginRoute(req, ctx);
  }

  // From here on, authentication is required.
  const user = await authenticate(ctx.db, req);
  if (!user) return json({ error: "unauthorized" }, 401);

  if (pathname === "/api/auth/logout" && req.method === "POST") {
    const token = getSessionToken(req);
    if (token) revokeSession(ctx.db, token);
    // Drop live notification SSE subscribers so the webview can't keep a
    // revoked session warm via the existing socket.
    closeNotificationFanoutsFor(user.id);
    void ctx.queue.log({ topic: "auth", kind: "logout", userId: user.id });
    return json(
      { ok: true },
      { headers: { "Set-Cookie": clearSessionCookieHeader() } },
    );
  }

  if (pathname === "/api/auth/me" && req.method === "GET") {
    return json({ user: publicUser(user) });
  }

  if (pathname === "/api/auth/password" && req.method === "POST") {
    return changeOwnPassword(req, ctx, user);
  }

  if (pathname === "/api/users/me" && req.method === "GET") {
    return json({ user: publicUser(user) });
  }

  if (pathname === "/api/users/me" && req.method === "PATCH") {
    return patchOwnProfile(req, ctx, user);
  }

  // Lightweight directory for @mention autocomplete — exposes username + display
  // name only (no role, email, timestamps), available to any signed-in user.
  if (pathname === "/api/users/directory" && req.method === "GET") {
    const q = url.searchParams.get("q") ?? undefined;
    const users = listUsers(ctx.db, { q, limit: 200 }).map((u) => ({
      id: u.id,
      username: u.username,
      displayName: u.displayName,
    }));
    return json({ users });
  }

  // API keys (own)
  if (pathname === "/api/apikeys" && req.method === "GET") {
    return json({ keys: listApiKeys(ctx.db, user.id) });
  }
  if (pathname === "/api/apikeys" && req.method === "POST") {
    return createApiKeyRoute(req, ctx, user);
  }
  const keyMatch = pathname.match(/^\/api\/apikeys\/([^/]+)$/);
  if (keyMatch && req.method === "DELETE") {
    const keyId = decodeURIComponent(keyMatch[1]!);
    const ok = revokeApiKey(ctx.db, keyId, user.id);
    if (ok)
      void ctx.queue.log({
        topic: "apikey",
        kind: "revoke",
        userId: user.id,
        data: { keyId },
      });
    return ok ? json({ ok: true }) : json({ error: "not found" }, 404);
  }

  // ── Admin routes ─────────────────────────────────────────────────────────
  if (pathname === "/api/users" && req.method === "GET") {
    if (user.role !== "admin") return json({ error: "forbidden" }, 403);
    const q = url.searchParams.get("q") ?? undefined;
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const users = listUsers(ctx.db, { q, limit, offset }).map(publicUser);
    return json({ users });
  }

  if (pathname === "/api/users" && req.method === "POST") {
    if (user.role !== "admin") return json({ error: "forbidden" }, 403);
    return createUserRoute(req, ctx, user);
  }

  const userMatch = pathname.match(/^\/api\/users\/([^/]+)$/);
  if (userMatch) {
    if (user.role !== "admin") return json({ error: "forbidden" }, 403);
    const id = decodeURIComponent(userMatch[1]!);
    if (req.method === "GET") {
      const u = getUserById(ctx.db, id);
      return u
        ? json({ user: publicUser(u) })
        : json({ error: "not found" }, 404);
    }
    if (req.method === "PATCH") return patchUserRoute(req, ctx, user, id);
    if (req.method === "DELETE") {
      if (id === user.id) return json({ error: "cannot delete self" }, 400);
      deleteUser(ctx.db, id);
      void ctx.queue.log({
        topic: "user",
        kind: "delete",
        userId: user.id,
        data: { targetId: id },
      });
      return json({ ok: true });
    }
  }

  const pwMatch = pathname.match(/^\/api\/users\/([^/]+)\/password$/);
  if (pwMatch && req.method === "POST") {
    if (user.role !== "admin") return json({ error: "forbidden" }, 403);
    return adminResetPasswordRoute(
      req,
      ctx,
      user,
      decodeURIComponent(pwMatch[1]!),
    );
  }

  return null;
}

// ── Handlers ───────────────────────────────────────────────────────────────

async function readJson<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

async function loginRoute(req: Request, ctx: AuthRouteCtx): Promise<Response> {
  const body = await readJson<{ username?: string; password?: string }>(req);
  if (!body?.username || !body?.password)
    return json({ error: "missing credentials" }, 400);

  const u = getUserByUsername(ctx.db, body.username);
  if (!u) {
    void ctx.queue.log({
      topic: "auth",
      kind: "login.failed",
      data: { username: body.username, reason: "user_not_found" },
    });
    return json({ error: "invalid credentials" }, 401);
  }

  const hash = getUserPasswordHash(ctx.db, u.id);
  if (!hash) {
    void ctx.queue.log({
      topic: "auth",
      kind: "login.failed",
      data: { username: body.username, reason: "no_password_hash" },
    });
    return json({ error: "invalid credentials" }, 401);
  }

  const ok = await verifyPassword(body.password, hash);
  if (!ok) {
    void ctx.queue.log({
      topic: "auth",
      kind: "login.failed",
      data: { username: body.username, reason: "bad_password" },
    });
    return json({ error: "invalid credentials" }, 401);
  }

  const ttlHours = ctx.cfg.auth.sessionTtlHours;
  const sess = issueSession(ctx.db, u.id, ttlHours);
  const cookie = setSessionCookieHeader(sess.token, ttlHours * 3600);

  void ctx.queue.log({
    topic: "auth",
    kind: "login",
    userId: u.id,
    data: { username: body.username },
  });
  return json({ user: publicUser(u) }, { headers: { "Set-Cookie": cookie } });
}

async function changeOwnPassword(
  req: Request,
  ctx: AuthRouteCtx,
  user: User,
): Promise<Response> {
  const body = await readJson<{
    currentPassword?: string;
    newPassword?: string;
  }>(req);
  if (!body?.newPassword || body.newPassword.length < 6) {
    return json({ error: "password too short" }, 400);
  }
  // If the user is in forced-change mode we skip the current-password check —
  // they used the temporary default to sign in and are now picking their own.
  if (!user.mustChangePassword) {
    if (!body.currentPassword)
      return json({ error: "missing current password" }, 400);
    const hash = getUserPasswordHash(ctx.db, user.id);
    const ok = hash ? await verifyPassword(body.currentPassword, hash) : false;
    if (!ok) return json({ error: "invalid credentials" }, 401);
  }
  await setPassword(ctx.db, user.id, body.newPassword, false);
  void ctx.queue.log({
    topic: "auth",
    kind: "password.change",
    userId: user.id,
  });
  return json({ ok: true });
}

async function patchOwnProfile(
  req: Request,
  ctx: AuthRouteCtx,
  user: User,
): Promise<Response> {
  const body = await readJson<{
    displayName?: string | null;
    email?: string | null;
    expandThinkBubbles?: boolean;
    expandToolBubbles?: boolean;
    preferredLanguage?: string | null;
  }>(req);
  if (!body) return json({ error: "invalid body" }, 400);
  let preferredLanguage: string | null | undefined;
  try {
    preferredLanguage = normalisePreferredLanguage(body.preferredLanguage);
  } catch (e) {
    return json(
      { error: e instanceof Error ? e.message : "invalid preferred_language" },
      400,
    );
  }
  const updated = updateUser(ctx.db, user.id, {
    displayName: body.displayName,
    email: body.email,
    expandThinkBubbles: body.expandThinkBubbles,
    expandToolBubbles: body.expandToolBubbles,
    preferredLanguage,
  });
  if (updated) {
    const changed = Object.keys(body).filter(
      (k) => (body as Record<string, unknown>)[k] !== undefined,
    );
    void ctx.queue.log({
      topic: "user",
      kind: "profile.update",
      userId: user.id,
      data: { changed },
    });
  }
  return updated
    ? json({ user: publicUser(updated) })
    : json({ error: "not found" }, 404);
}

async function createApiKeyRoute(
  req: Request,
  ctx: AuthRouteCtx,
  user: User,
): Promise<Response> {
  const body = await readJson<{
    name?: string;
    expiresAt?: number | null;
    ttlDays?: number;
  }>(req);
  if (!body?.name || !body.name.trim())
    return json({ error: "name required" }, 400);
  let expiresAt: number | null = body.expiresAt ?? null;
  if (expiresAt === null && body.ttlDays && body.ttlDays > 0) {
    expiresAt = Date.now() + body.ttlDays * 86_400_000;
  }
  const result = await createApiKey(
    ctx.db,
    user.id,
    body.name.trim(),
    expiresAt,
  );
  void ctx.queue.log({
    topic: "apikey",
    kind: "create",
    userId: user.id,
    data: { name: body.name.trim(), keyId: result.meta.id, expiresAt },
  });
  return json({ key: result.secret, meta: result.meta }, 201);
}

async function createUserRoute(
  req: Request,
  ctx: AuthRouteCtx,
  admin: User,
): Promise<Response> {
  const body = await readJson<{
    username?: string;
    password?: string;
    role?: UserRole;
    displayName?: string;
    email?: string;
  }>(req);
  if (!body?.username || !body.password)
    return json({ error: "missing fields" }, 400);
  if (getUserByUsername(ctx.db, body.username))
    return json({ error: "username taken" }, 409);
  const u = await createUser(ctx.db, {
    username: body.username,
    password: body.password,
    role: body.role ?? "user",
    displayName: body.displayName ?? null,
    email: body.email ?? null,
    mustChangePassword: true,
  });
  void ctx.queue.log({
    topic: "user",
    kind: "create",
    userId: admin.id,
    data: { username: body.username, role: body.role ?? "user" },
  });
  return json({ user: publicUser(u) }, 201);
}

async function patchUserRoute(
  req: Request,
  ctx: AuthRouteCtx,
  user: User,
  id: string,
): Promise<Response> {
  const body = await readJson<{
    role?: UserRole;
    displayName?: string | null;
    email?: string | null;
  }>(req);
  if (!body) return json({ error: "invalid body" }, 400);
  const updated = updateUser(ctx.db, id, body);
  if (updated) {
    const changed = Object.keys(body).filter(
      (k) => (body as Record<string, unknown>)[k] !== undefined,
    );
    void ctx.queue.log({
      topic: "user",
      kind: "update",
      userId: user.id,
      data: { targetId: id, changed },
    });
  }
  return updated
    ? json({ user: publicUser(updated) })
    : json({ error: "not found" }, 404);
}

async function adminResetPasswordRoute(
  req: Request,
  ctx: AuthRouteCtx,
  admin: User,
  id: string,
): Promise<Response> {
  const body = await readJson<{ password?: string }>(req);
  if (!body?.password || body.password.length < 6)
    return json({ error: "password too short" }, 400);
  await setPassword(ctx.db, id, body.password, true);
  revokeUserSessions(ctx.db, id);
  void ctx.queue.log({
    topic: "user",
    kind: "password.reset",
    userId: admin.id,
    data: { targetId: id },
  });
  return json({ ok: true });
}
