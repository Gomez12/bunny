/**
 * Global per-user UI preferences stored in `users.ui_prefs` (JSON blob).
 *
 * Preferences here follow the user across all devices. Ephemeral/device-specific
 * state stays in localStorage and is NOT managed here.
 */

import type { Database } from "bun:sqlite";

export interface GlobalUiPrefs {
  theme?: "light" | "dark";
  activeProject?: string;
  activeTab?: string;
  newsTemplate?: "list" | "newspaper";
  /** Project to seed new Quick Chat sessions in (Electron mini-window etc.).
   *  Empty string / null on patch clears the field; absent → no preference. */
  defaultQuickChatProject?: string | null;
}

const ALLOWED_KEYS = new Set<string>([
  "theme",
  "activeProject",
  "activeTab",
  "newsTemplate",
  "defaultQuickChatProject",
]);

export function parseGlobalUiPrefs(raw: string): GlobalUiPrefs {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const out: GlobalUiPrefs = {};
    const theme = obj["theme"];
    if (theme === "light" || theme === "dark") out.theme = theme;
    const activeProject = obj["activeProject"];
    if (typeof activeProject === "string") out.activeProject = activeProject;
    const activeTab = obj["activeTab"];
    if (typeof activeTab === "string") out.activeTab = activeTab;
    const newsTemplate = obj["newsTemplate"];
    if (newsTemplate === "list" || newsTemplate === "newspaper")
      out.newsTemplate = newsTemplate;
    const dqcp = obj["defaultQuickChatProject"];
    if (typeof dqcp === "string" && dqcp.length > 0)
      out.defaultQuickChatProject = dqcp;
    return out;
  } catch {
    return {};
  }
}

export function validateGlobalUiPrefsPatch(patch: unknown): GlobalUiPrefs {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("prefs must be an object");
  }
  const p = patch as Record<string, unknown>;
  const unknownKeys = Object.keys(p).filter((k) => !ALLOWED_KEYS.has(k));
  if (unknownKeys.length) throw new Error(`unknown pref keys: ${unknownKeys.join(", ")}`);

  const out: GlobalUiPrefs = {};
  if ("theme" in p) {
    const v = p["theme"];
    if (v !== "light" && v !== "dark")
      throw new Error("theme must be 'light' or 'dark'");
    out.theme = v;
  }
  if ("activeProject" in p) {
    const v = p["activeProject"];
    if (typeof v !== "string")
      throw new Error("activeProject must be a string");
    out.activeProject = v;
  }
  if ("activeTab" in p) {
    const v = p["activeTab"];
    if (typeof v !== "string")
      throw new Error("activeTab must be a string");
    out.activeTab = v;
  }
  if ("newsTemplate" in p) {
    const v = p["newsTemplate"];
    if (v !== "list" && v !== "newspaper")
      throw new Error("newsTemplate must be 'list' or 'newspaper'");
    out.newsTemplate = v;
  }
  if ("defaultQuickChatProject" in p) {
    const v = p["defaultQuickChatProject"];
    if (v !== null && typeof v !== "string")
      throw new Error("defaultQuickChatProject must be a string or null");
    // Empty string / null both mean "no preference" — store as null so the
    // parser drops it on the next read. Project-name validation lives in
    // `getProject` at usage time; we don't fail the PUT if the project is
    // currently inaccessible (the user may regain access later).
    out.defaultQuickChatProject = v && v.length > 0 ? v : null;
  }
  return out;
}

export function getGlobalUiPrefs(db: Database, userId: string): GlobalUiPrefs {
  const row = db
    .prepare("SELECT ui_prefs FROM users WHERE id = ?")
    .get(userId) as { ui_prefs: string } | null;
  return row ? parseGlobalUiPrefs(row.ui_prefs) : {};
}

export function setGlobalUiPrefs(
  db: Database,
  userId: string,
  patch: GlobalUiPrefs,
): GlobalUiPrefs {
  const current = getGlobalUiPrefs(db, userId);
  const next = { ...current, ...patch };
  db.prepare("UPDATE users SET ui_prefs = ?, updated_at = ? WHERE id = ?").run(
    JSON.stringify(next),
    Date.now(),
    userId,
  );
  return next;
}
