/**
 * Planning wishes — the work items inside a planning project. Each wish has
 * a duration in working days, an optional team and deadline, an optional
 * placement on the timeline (planned_start_date / planned_end_date), and
 * dependency lists (other wishes by id, or tags by name) stored as JSON.
 *
 * Tags are first-class — the M:N junction (planning_wish_tags) feeds both
 * the UI filter and the scheduler's tag-dependency resolver.
 */

import type { Database } from "bun:sqlite";
import { registerTrashable, softDelete } from "./trash.ts";
import { registerVersionable } from "./versioning.ts";
import { projectScopedAccess } from "./versioning_access.ts";

registerTrashable({
  kind: "planning_wish",
  table: "planning_wishes",
  nameColumn: "title",
  hasUniqueName: false,
  scopeColumn: "planning_project_id",
  translationSidecarTable: null,
  translationSidecarFk: null,
});

// Wishes own their tag membership via the `planning_wish_tags` M:N junction —
// the tag set is part of the user-edited shape of a wish so we bake it into
// the snapshot and rebuild it on restore. `advice_hide_*` is dismissal state
// tied to a *proposed* schedule change; restoring it would resurrect a
// tooltip-suppression the user no longer wants, so we leave it on the live
// row and omit it from snapshots.
registerVersionable({
  kind: "planning_wish",
  table: "planning_wishes",
  primaryKey: "id",
  sidecars: ["planning_wish_tags (snapshotted as tag_ids array)"],
  snapshot(db, id) {
    const wishId = Number(id);
    const row = db
      .prepare(
        `SELECT id, planning_project_id, project, title, description,
                duration_days, team_id, deadline_id, planned_start_date,
                planned_end_date, status, depends_on_wishes, depends_on_tags,
                jira_key, created_by, created_at, updated_at
           FROM planning_wishes WHERE id = ?`,
      )
      .get(wishId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const tagIds = (
      db
        .prepare(
          `SELECT tag_id FROM planning_wish_tags WHERE wish_id = ? ORDER BY tag_id ASC`,
        )
        .all(wishId) as { tag_id: number }[]
    ).map((r) => r.tag_id);
    return { ...row, tag_ids: tagIds };
  },
  restore(db, id, snapshot) {
    const wishId = Number(id);
    db.prepare(
      `UPDATE planning_wishes
          SET title = ?, description = ?, duration_days = ?, team_id = ?,
              deadline_id = ?, planned_start_date = ?, planned_end_date = ?,
              status = ?, depends_on_wishes = ?, depends_on_tags = ?,
              jira_key = ?, updated_at = ?
        WHERE id = ?`,
    ).run(
      String(snapshot["title"] ?? ""),
      String(snapshot["description"] ?? ""),
      Number(snapshot["duration_days"] ?? 1),
      (snapshot["team_id"] as number | null) ?? null,
      (snapshot["deadline_id"] as number | null) ?? null,
      (snapshot["planned_start_date"] as string | null) ?? null,
      (snapshot["planned_end_date"] as string | null) ?? null,
      String(snapshot["status"] ?? "planned"),
      String(snapshot["depends_on_wishes"] ?? "[]"),
      String(snapshot["depends_on_tags"] ?? "[]"),
      (snapshot["jira_key"] as string | null) ?? null,
      Date.now(),
      wishId,
    );
    db.prepare(`DELETE FROM planning_wish_tags WHERE wish_id = ?`).run(wishId);
    const tagIds = Array.isArray(snapshot["tag_ids"])
      ? (snapshot["tag_ids"] as unknown[]).filter(
          (v): v is number => typeof v === "number",
        )
      : [];
    const insertTag = db.prepare(
      `INSERT INTO planning_wish_tags(wish_id, tag_id) VALUES (?, ?)`,
    );
    for (const tagId of tagIds) insertTag.run(wishId, tagId);
  },
  canSee: (db, userId, id) =>
    projectScopedAccess(db, userId, "planning_wishes", "id", id, "see"),
  canEdit: (db, userId, id) =>
    projectScopedAccess(db, userId, "planning_wishes", "id", id, "edit"),
});

export type WishStatus = "planned" | "in_progress" | "done";

export interface AdviceHide {
  start: string | null;
  end: string | null;
  teamId: number | null;
}

export interface PlanningWish {
  id: number;
  planningProjectId: number;
  project: string;
  title: string;
  description: string;
  durationDays: number;
  teamId: number | null;
  deadlineId: number | null;
  plannedStartDate: string | null;
  plannedEndDate: string | null;
  status: WishStatus;
  dependsOnWishes: number[];
  dependsOnTags: string[];
  tagIds: number[];
  /** Optional external tracker reference (e.g. Jira `PROJ-123`). User-entered
   *  free text; trimmed but not format-validated. */
  jiraKey: string | null;
  /** When non-null on all three keys, the user has dismissed schedule advice
   *  proposing exactly this (start, end, team_id). Cleared by re-issuing
   *  advice with different values, or by an explicit "Show again" action. */
  adviceHide: AdviceHide;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

interface WishRow {
  id: number;
  planning_project_id: number;
  project: string;
  title: string;
  description: string;
  duration_days: number;
  team_id: number | null;
  deadline_id: number | null;
  planned_start_date: string | null;
  planned_end_date: string | null;
  status: string;
  depends_on_wishes: string;
  depends_on_tags: string;
  jira_key: string | null;
  advice_hide_start: string | null;
  advice_hide_end: string | null;
  advice_hide_team_id: number | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

function safeParseJsonArray<T>(raw: string, label: string): T[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    throw new Error(`malformed ${label} JSON: ${raw.slice(0, 80)}`);
  }
}

function rowToWish(r: WishRow, tagIds: number[]): PlanningWish {
  const status: WishStatus =
    r.status === "in_progress" || r.status === "done" ? r.status : "planned";
  return {
    id: r.id,
    planningProjectId: r.planning_project_id,
    project: r.project,
    title: r.title,
    description: r.description,
    durationDays: r.duration_days,
    teamId: r.team_id,
    deadlineId: r.deadline_id,
    plannedStartDate: r.planned_start_date,
    plannedEndDate: r.planned_end_date,
    status,
    dependsOnWishes: safeParseJsonArray<number>(r.depends_on_wishes, "depends_on_wishes"),
    dependsOnTags: safeParseJsonArray<string>(r.depends_on_tags, "depends_on_tags"),
    tagIds,
    jiraKey: r.jira_key,
    adviceHide: {
      start: r.advice_hide_start,
      end: r.advice_hide_end,
      teamId: r.advice_hide_team_id,
    },
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const SELECT_COLS = `id, planning_project_id, project, title, description,
                     duration_days, team_id, deadline_id,
                     planned_start_date, planned_end_date, status,
                     depends_on_wishes, depends_on_tags, jira_key,
                     advice_hide_start, advice_hide_end, advice_hide_team_id,
                     created_by, created_at, updated_at`;

function normaliseJiraKey(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (trimmed.length > 64)
    throw new Error("jira_key must be 64 characters or fewer");
  return trimmed;
}

function loadTagsForWishes(
  db: Database,
  wishIds: number[],
): Map<number, number[]> {
  const map = new Map<number, number[]>();
  if (wishIds.length === 0) return map;
  const placeholders = wishIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT wish_id, tag_id FROM planning_wish_tags
        WHERE wish_id IN (${placeholders})`,
    )
    .all(...wishIds) as { wish_id: number; tag_id: number }[];
  for (const r of rows) {
    const list = map.get(r.wish_id);
    if (list) list.push(r.tag_id);
    else map.set(r.wish_id, [r.tag_id]);
  }
  return map;
}

export function listWishes(
  db: Database,
  planningProjectId: number,
): PlanningWish[] {
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLS} FROM planning_wishes
        WHERE planning_project_id = ? AND deleted_at IS NULL
        ORDER BY created_at ASC`,
    )
    .all(planningProjectId) as WishRow[];
  const tagsMap = loadTagsForWishes(db, rows.map((r) => r.id));
  return rows.map((r) => rowToWish(r, tagsMap.get(r.id) ?? []));
}

export function getWish(db: Database, id: number): PlanningWish | null {
  const row = db
    .prepare(
      `SELECT ${SELECT_COLS} FROM planning_wishes
        WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(id) as WishRow | undefined;
  if (!row) return null;
  const tagsMap = loadTagsForWishes(db, [row.id]);
  return rowToWish(row, tagsMap.get(row.id) ?? []);
}

function clampDuration(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return 1;
  if (n > 9999) return 9999;
  return Math.floor(n);
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function validateOptionalIsoDate(
  raw: unknown,
  label: string,
): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw !== "string" || !ISO_DATE_RE.test(raw))
    throw new Error(`${label} must be an ISO YYYY-MM-DD date`);
  return raw;
}

function validateStatus(raw: unknown): WishStatus {
  if (raw === "in_progress" || raw === "done") return raw;
  return "planned";
}

function replaceWishTags(db: Database, wishId: number, tagIds: number[]): void {
  db.prepare(`DELETE FROM planning_wish_tags WHERE wish_id = ?`).run(wishId);
  if (tagIds.length === 0) return;
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO planning_wish_tags(wish_id, tag_id) VALUES (?, ?)`,
  );
  for (const tagId of tagIds) stmt.run(wishId, tagId);
}

export interface CreateWishOpts {
  planningProjectId: number;
  project: string;
  title: string;
  description?: string;
  durationDays?: number;
  teamId?: number | null;
  deadlineId?: number | null;
  plannedStartDate?: string | null;
  plannedEndDate?: string | null;
  status?: WishStatus;
  dependsOnWishes?: number[];
  dependsOnTags?: string[];
  tagIds?: number[];
  jiraKey?: string | null;
  createdBy: string;
}

export function createWish(db: Database, opts: CreateWishOpts): PlanningWish {
  const durationDays = clampDuration(opts.durationDays ?? 1);
  const start = validateOptionalIsoDate(
    opts.plannedStartDate ?? null,
    "planned_start_date",
  );
  const end = validateOptionalIsoDate(
    opts.plannedEndDate ?? null,
    "planned_end_date",
  );
  const status = validateStatus(opts.status ?? "planned");
  const dependsOnWishes = JSON.stringify(opts.dependsOnWishes ?? []);
  const dependsOnTags = JSON.stringify(opts.dependsOnTags ?? []);
  const jiraKey = normaliseJiraKey(opts.jiraKey ?? null);
  const now = Date.now();
  const tx = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO planning_wishes(planning_project_id, project, title,
                                     description, duration_days, team_id,
                                     deadline_id, planned_start_date,
                                     planned_end_date, status,
                                     depends_on_wishes, depends_on_tags,
                                     jira_key,
                                     created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        opts.planningProjectId,
        opts.project,
        opts.title,
        opts.description ?? "",
        durationDays,
        opts.teamId ?? null,
        opts.deadlineId ?? null,
        start,
        end,
        status,
        dependsOnWishes,
        dependsOnTags,
        jiraKey,
        opts.createdBy,
        now,
        now,
      );
    const id = Number(info.lastInsertRowid);
    if (opts.tagIds && opts.tagIds.length > 0) replaceWishTags(db, id, opts.tagIds);
    return id;
  });
  return getWish(db, tx())!;
}

export interface UpdateWishPatch {
  title?: string;
  description?: string;
  durationDays?: number;
  teamId?: number | null;
  deadlineId?: number | null;
  plannedStartDate?: string | null;
  plannedEndDate?: string | null;
  status?: WishStatus;
  dependsOnWishes?: number[];
  dependsOnTags?: string[];
  tagIds?: number[];
  jiraKey?: string | null;
}

export function updateWish(
  db: Database,
  id: number,
  patch: UpdateWishPatch,
): PlanningWish {
  const existing = getWish(db, id);
  if (!existing) throw new Error(`wish ${id} not found`);
  const title = patch.title === undefined ? existing.title : patch.title;
  const description =
    patch.description === undefined ? existing.description : patch.description;
  const durationDays =
    patch.durationDays === undefined
      ? existing.durationDays
      : clampDuration(patch.durationDays);
  const teamId = patch.teamId === undefined ? existing.teamId : patch.teamId;
  const deadlineId =
    patch.deadlineId === undefined ? existing.deadlineId : patch.deadlineId;
  const plannedStartDate =
    patch.plannedStartDate === undefined
      ? existing.plannedStartDate
      : validateOptionalIsoDate(patch.plannedStartDate, "planned_start_date");
  const plannedEndDate =
    patch.plannedEndDate === undefined
      ? existing.plannedEndDate
      : validateOptionalIsoDate(patch.plannedEndDate, "planned_end_date");
  const status =
    patch.status === undefined ? existing.status : validateStatus(patch.status);
  const dependsOnWishes =
    patch.dependsOnWishes === undefined
      ? existing.dependsOnWishes
      : patch.dependsOnWishes;
  const dependsOnTags =
    patch.dependsOnTags === undefined
      ? existing.dependsOnTags
      : patch.dependsOnTags;
  const jiraKey =
    patch.jiraKey === undefined
      ? existing.jiraKey
      : normaliseJiraKey(patch.jiraKey);
  const now = Date.now();
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE planning_wishes
         SET title = ?, description = ?, duration_days = ?,
             team_id = ?, deadline_id = ?,
             planned_start_date = ?, planned_end_date = ?,
             status = ?,
             depends_on_wishes = ?, depends_on_tags = ?,
             jira_key = ?,
             updated_at = ?
       WHERE id = ?`,
    ).run(
      title,
      description,
      durationDays,
      teamId,
      deadlineId,
      plannedStartDate,
      plannedEndDate,
      status,
      JSON.stringify(dependsOnWishes),
      JSON.stringify(dependsOnTags),
      jiraKey,
      now,
      id,
    );
    if (patch.tagIds !== undefined) replaceWishTags(db, id, patch.tagIds);
  });
  tx();
  return getWish(db, id)!;
}

export function deleteWish(
  db: Database,
  id: number,
  deletedBy: string | null = null,
): void {
  softDelete(db, "planning_wish", id, deletedBy);
}

/**
 * Set or clear the advice-hide tuple for a wish. Pass `null` to clear.
 * Returns the updated wish.
 */
export function setWishAdviceHide(
  db: Database,
  id: number,
  hide: { start: string; end: string; teamId: number | null } | null,
): PlanningWish {
  if (hide === null) {
    db.prepare(
      `UPDATE planning_wishes
         SET advice_hide_start = NULL,
             advice_hide_end = NULL,
             advice_hide_team_id = NULL,
             updated_at = ?
       WHERE id = ?`,
    ).run(Date.now(), id);
  } else {
    if (!ISO_DATE_RE.test(hide.start) || !ISO_DATE_RE.test(hide.end))
      throw new Error("advice_hide start/end must be ISO YYYY-MM-DD dates");
    db.prepare(
      `UPDATE planning_wishes
         SET advice_hide_start = ?,
             advice_hide_end = ?,
             advice_hide_team_id = ?,
             updated_at = ?
       WHERE id = ?`,
    ).run(hide.start, hide.end, hide.teamId, Date.now(), id);
  }
  const w = getWish(db, id);
  if (!w) throw new Error(`wish ${id} not found`);
  return w;
}

/**
 * Apply scheduler placements to wishes in one transaction. Used when the
 * user accepts a suggestion. Returns the wish IDs whose dates actually
 * changed (so the caller can dispatch deadline-conflict notifications).
 */
export function applyPlacements(
  db: Database,
  placements: { wishId: number; start: string; end: string }[],
): number[] {
  const changed: number[] = [];
  const now = Date.now();
  const stmt = db.prepare(
    `UPDATE planning_wishes
       SET planned_start_date = ?, planned_end_date = ?, updated_at = ?
     WHERE id = ? AND deleted_at IS NULL
       AND (planned_start_date IS NOT ? OR planned_end_date IS NOT ?)`,
  );
  const tx = db.transaction(() => {
    for (const p of placements) {
      const info = stmt.run(p.start, p.end, now, p.wishId, p.start, p.end);
      if (info.changes > 0) changed.push(p.wishId);
    }
  });
  tx();
  return changed;
}
