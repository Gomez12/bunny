/**
 * UI preference routes.
 *
 * GET/PUT /api/users/me/ui-prefs             — global per-user prefs
 * GET/PUT /api/projects/:project/ui-prefs/me — per-(user, project) prefs
 *
 * Write cadence is debounced auto-save from the frontend, not user-triggered
 * profile saves. Dedicated endpoints keep the write cadence separate from
 * PATCH /api/users/me (which triggers profile-save queuing).
 */

import type { Database } from "bun:sqlite";
import type { BunnyQueue } from "../queue/bunqueue.ts";
import type { User } from "../auth/users.ts";
import { json, readJson } from "./http.ts";
import { requireProjectAccess } from "./route_helpers.ts";
import {
  getGlobalUiPrefs,
  setGlobalUiPrefs,
  validateGlobalUiPrefsPatch,
} from "../memory/ui_prefs.ts";
import {
  getUserProjectPrefs,
  setUserProjectPrefs,
  validateProjectUiPrefsPatch,
} from "../memory/user_project_prefs.ts";

export interface UiPrefsRouteCtx {
  db: Database;
  queue: BunnyQueue;
}

const PROJECT_UI_PREFS_RE = /^\/api\/projects\/([^/]+)\/ui-prefs\/me$/;

export async function handleUiPrefsRoute(
  req: Request,
  url: URL,
  ctx: UiPrefsRouteCtx,
  user: User,
): Promise<Response | null> {
  const { pathname } = url;

  // ── Global prefs ──────────────────────────────────────────────────────────
  if (pathname === "/api/users/me/ui-prefs") {
    if (req.method === "GET") {
      return json({ prefs: getGlobalUiPrefs(ctx.db, user.id) });
    }
    if (req.method === "PUT") {
      const body = await readJson<unknown>(req);
      let patch;
      try {
        patch = validateGlobalUiPrefsPatch(body);
      } catch (e) {
        return json(
          { error: e instanceof Error ? e.message : "invalid prefs" },
          400,
        );
      }
      const prefs = setGlobalUiPrefs(ctx.db, user.id, patch);
      void ctx.queue.log({
        topic: "user",
        kind: "ui_prefs.update",
        userId: user.id,
        data: { keys: Object.keys(patch) },
      });
      return json({ prefs });
    }
  }

  // ── Per-project prefs ─────────────────────────────────────────────────────
  const projectMatch = pathname.match(PROJECT_UI_PREFS_RE);
  if (projectMatch) {
    const result = requireProjectAccess(
      ctx.db,
      user,
      decodeURIComponent(projectMatch[1]!),
      "view",
    );
    if (!result.ok) return result.response;
    const { project } = result;

    if (req.method === "GET") {
      return json({ prefs: getUserProjectPrefs(ctx.db, user.id, project) });
    }
    if (req.method === "PUT") {
      const body = await readJson<unknown>(req);
      let patch;
      try {
        patch = validateProjectUiPrefsPatch(body);
      } catch (e) {
        return json(
          { error: e instanceof Error ? e.message : "invalid prefs" },
          400,
        );
      }
      const prefs = setUserProjectPrefs(ctx.db, user.id, project, patch);
      void ctx.queue.log({
        topic: "user",
        kind: "ui_prefs.project.update",
        userId: user.id,
        data: { project, keys: Object.keys(patch) },
      });
      return json({ prefs });
    }
  }

  return null;
}
