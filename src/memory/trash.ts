/**
 * Trash bin — entity-agnostic soft-delete + restore + hard-delete.
 *
 * Four entities can be soft-deleted today: documents, whiteboards, contacts,
 * kb_definitions. Board cards have their own `archived_at` flow and stay out
 * of scope. Each entity module registers itself on import (mirroring the
 * pattern in `translatable.ts`) so the trash routes never need to know about
 * specific tables.
 *
 * Why rename-on-soft-delete:
 * The table-level UNIQUE(project, name|term) on documents, whiteboards and
 * kb_definitions cannot be weakened by a partial index — a table constraint
 * creates a full implicit unique index that still blocks reinserts that
 * collide with the soft-deleted row. Dropping the constraint is disallowed by
 * the append-only schema policy. We therefore rename the row to
 * `__trash:<id>:<original>` on soft-delete, which frees the UNIQUE so the user
 * can re-create "Plan" immediately. On restore we try to put the original name
 * back; if it's taken we return `"name_conflict"` and let the admin resolve it
 * (rename the live one, or hard-delete this one).
 *
 * See ADR 0025.
 */

import type { Database } from "bun:sqlite";
import { createTranslationSlots, getKind } from "./translatable.ts";

export type TrashKind =
  | "document"
  | "whiteboard"
  | "contact"
  | "kb_definition"
  | "code_project"
  | "workflow"
  | "business";

export type RestoreOutcome = "ok" | "not_found" | "name_conflict";

/** Shape of one row as it appears in the admin Trash list. */
export interface TrashItem {
  kind: TrashKind;
  id: number;
  name: string; // original name (trash prefix stripped for display)
  project: string;
  deletedAt: number;
  deletedBy: string | null;
  createdBy: string | null;
  createdAt: number;
}

/**
 * Describes how one entity participates in the trash system. One `register`
 * call per entity module; the HTTP layer only ever talks to this interface.
 * Translation reseeding piggybacks on `translatable.ts`: if a matching
 * `TranslatableKind` is registered (same `kind` name), `restore` re-creates
 * its sidecar rows automatically.
 */
export interface TrashEntityDef {
  readonly kind: TrashKind;
  readonly table: string;
  /** The `name` / `term` column — used both for list display and rename-on-soft-delete. */
  readonly nameColumn: string;
  /** True when `UNIQUE(project, nameColumn)` is enforced; triggers the rename dance. */
  readonly hasUniqueName: boolean;
  /** Sidecar table dropped on soft-delete (null = entity is not translatable). */
  readonly translationSidecarTable: string | null;
  readonly translationSidecarFk: string | null;
}

const REGISTRY: Map<TrashKind, TrashEntityDef> = new Map();

export function registerTrashable(def: TrashEntityDef): void {
  REGISTRY.set(def.kind, def);
}

export function getTrashDef(kind: string): TrashEntityDef | undefined {
  return REGISTRY.get(kind as TrashKind);
}

function requireDef(kind: TrashKind): TrashEntityDef {
  const def = REGISTRY.get(kind);
  if (!def) throw new Error(`unknown trash kind: ${kind}`);
  return def;
}

// ── Name mangling ───────────────────────────────────────────────────────────

const TRASH_PREFIX_RE = /^__trash:(\d+):/;

function mangleName(id: number, original: string): string {
  return `__trash:${id}:${original}`;
}

/** Strip the trash prefix for display or restore. Returns the original string
 *  when the prefix is absent (legacy / paranoid fallback). */
export function displayName(raw: string): string {
  return raw.replace(TRASH_PREFIX_RE, "");
}

// ── Core operations ─────────────────────────────────────────────────────────

/**
 * Flip one entity into the trash. Renames the name/term column to
 * `__trash:<id>:<original>` when `hasUniqueName`, drops any translation
 * sidecars (they'll be re-seeded on restore), and stamps `deleted_at` +
 * `deleted_by`. All of this runs in a single transaction so either everything
 * succeeds or the row stays untouched.
 *
 * Returns false when the row does not exist or was already soft-deleted.
 */
export function softDelete(
  db: Database,
  kind: TrashKind,
  id: number,
  userId: string | null,
): boolean {
  const def = requireDef(kind);
  const tx = db.transaction(() => {
    const row = db
      .prepare(
        `SELECT ${def.nameColumn} AS name_col, deleted_at
           FROM ${def.table} WHERE id = ?`,
      )
      .get(id) as { name_col: string; deleted_at: number | null } | undefined;
    if (!row) return false;
    if (row.deleted_at !== null) return false;

    const now = Date.now();
    if (def.hasUniqueName) {
      const mangled = mangleName(id, row.name_col);
      db.prepare(
        `UPDATE ${def.table}
            SET ${def.nameColumn} = ?,
                deleted_at = ?,
                deleted_by = ?,
                updated_at = ?
          WHERE id = ?`,
      ).run(mangled, now, userId, now, id);
    } else {
      db.prepare(
        `UPDATE ${def.table}
            SET deleted_at = ?,
                deleted_by = ?,
                updated_at = ?
          WHERE id = ?`,
      ).run(now, userId, now, id);
    }

    if (def.translationSidecarTable && def.translationSidecarFk) {
      db.prepare(
        `DELETE FROM ${def.translationSidecarTable}
          WHERE ${def.translationSidecarFk} = ?`,
      ).run(id);
    }
    return true;
  });
  return tx();
}

/**
 * Restore a soft-deleted row. Strips the trash prefix, clears `deleted_at` /
 * `deleted_by`, and triggers translation re-seed if applicable.
 *
 * Returns:
 * - `"ok"` on success.
 * - `"not_found"` when the id does not exist or is not soft-deleted.
 * - `"name_conflict"` when another live row already uses the original name.
 */
export function restore(
  db: Database,
  kind: TrashKind,
  id: number,
): RestoreOutcome {
  const def = requireDef(kind);
  const outcome = db.transaction((): RestoreOutcome => {
    const row = db
      .prepare(
        `SELECT project, ${def.nameColumn} AS name_col, deleted_at
           FROM ${def.table} WHERE id = ?`,
      )
      .get(id) as
      | { project: string; name_col: string; deleted_at: number | null }
      | undefined;
    if (!row) return "not_found";
    if (row.deleted_at === null) return "not_found";

    const original = displayName(row.name_col);
    const now = Date.now();

    if (def.hasUniqueName) {
      const conflict = db
        .prepare(
          `SELECT id FROM ${def.table}
            WHERE project = ? AND ${def.nameColumn} = ?
              AND deleted_at IS NULL
              AND id != ?`,
        )
        .get(row.project, original, id) as { id: number } | undefined;
      if (conflict) return "name_conflict";

      db.prepare(
        `UPDATE ${def.table}
            SET ${def.nameColumn} = ?,
                deleted_at = NULL,
                deleted_by = NULL,
                updated_at = ?
          WHERE id = ?`,
      ).run(original, now, id);
    } else {
      db.prepare(
        `UPDATE ${def.table}
            SET deleted_at = NULL,
                deleted_by = NULL,
                updated_at = ?
          WHERE id = ?`,
      ).run(now, id);
    }

    return "ok";
  })();

  if (outcome === "ok") {
    const translatableKind = getKind(def.kind);
    if (translatableKind) createTranslationSlots(db, translatableKind, id);
  }
  return outcome;
}

/**
 * Hard-delete a soft-deleted row (called from the admin Trash tab). Refuses
 * to wipe a live row — callers must soft-delete first so the blast radius of
 * an errant click stays bounded.
 */
export function hardDelete(db: Database, kind: TrashKind, id: number): boolean {
  const def = requireDef(kind);
  const tx = db.transaction(() => {
    const row = db
      .prepare(`SELECT deleted_at FROM ${def.table} WHERE id = ?`)
      .get(id) as { deleted_at: number | null } | undefined;
    if (!row || row.deleted_at === null) return false;
    db.prepare(`DELETE FROM ${def.table} WHERE id = ?`).run(id);
    return true;
  });
  return tx();
}

// ── Admin list ──────────────────────────────────────────────────────────────

/**
 * List every soft-deleted row across every registered entity kind, newest
 * first. The admin-only Trash tab renders the result directly.
 */
export function listTrash(db: Database): TrashItem[] {
  const items: TrashItem[] = [];
  for (const def of REGISTRY.values()) {
    // No per-table ORDER BY — the JS sort below is authoritative across kinds.
    const rows = db
      .prepare(
        `SELECT id, project, ${def.nameColumn} AS name_col, deleted_at,
                deleted_by, created_by, created_at
           FROM ${def.table}
          WHERE deleted_at IS NOT NULL`,
      )
      .all() as Array<{
      id: number;
      project: string;
      name_col: string;
      deleted_at: number;
      deleted_by: string | null;
      created_by: string | null;
      created_at: number;
    }>;
    for (const r of rows) {
      items.push({
        kind: def.kind,
        id: r.id,
        name: displayName(r.name_col),
        project: r.project,
        deletedAt: r.deleted_at,
        deletedBy: r.deleted_by,
        createdBy: r.created_by,
        createdAt: r.created_at,
      });
    }
  }
  items.sort((a, b) => b.deletedAt - a.deletedAt);
  return items;
}
