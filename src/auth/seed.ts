/**
 * Seed the `users` table with a default admin when empty.
 *
 * Also guarantees a `system` user exists for anonymous CLI usage — this user
 * has a random unusable password so it cannot log in via the web UI.
 */

import type { Database } from "bun:sqlite";
import type { AuthConfig } from "../config.ts";
import { createUser, getUserByUsername, hasAnyUser } from "./users.ts";

export const SYSTEM_USERNAME = "system";

export async function ensureSeedUsers(db: Database, auth: AuthConfig): Promise<void> {
  if (!hasAnyUser(db)) {
    await createUser(db, {
      username: auth.defaultAdminUsername,
      password: auth.defaultAdminPassword,
      role: "admin",
      displayName: "Administrator",
      mustChangePassword: true,
    });
  }
  if (!getUserByUsername(db, SYSTEM_USERNAME)) {
    // Unusable password — 64 random hex chars, never returned anywhere.
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const unusable = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    await createUser(db, {
      username: SYSTEM_USERNAME,
      password: unusable,
      role: "user",
      displayName: "CLI (anonymous)",
      mustChangePassword: false,
    });
  }
}

export function getSystemUserId(db: Database): string {
  const u = getUserByUsername(db, SYSTEM_USERNAME);
  if (!u) throw new Error("System user not seeded — call ensureSeedUsers() first");
  return u.id;
}
