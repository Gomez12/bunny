/**
 * Planning notifications. Two kinds:
 *
 *   `planning.wish.assigned`  → fired when `team_id` on a wish moves from
 *                               null/old → new. Recipients = members of the
 *                               new team (minus the actor).
 *   `planning.deadline.conflict` → fired when, after a mutation, a wish's
 *                               `planned_end_date` exceeds its deadline's
 *                               `due_date`. Recipients = members of the
 *                               wish's team plus project admins.
 *
 * Deduplication for `planning.deadline.conflict`: skip when an unread
 * notification of the same kind for the same wish already exists in the
 * configured dedup window (default 24h).
 */

import type { Database } from "bun:sqlite";
import type { BunnyQueue } from "../queue/bunqueue.ts";
import {
  createNotification,
  notificationToDto,
} from "../memory/notifications.ts";
import { listTeamMembers } from "../memory/planning_teams.ts";
import { publish } from "../notifications/fanout.ts";
import type { Notification } from "../memory/notifications.ts";

function publishToUser(userId: string, notif: Notification): void {
  publish(userId, {
    type: "notification_created",
    notification: notificationToDto(notif),
  });
}

function buildDeepLink(project: string, planningProjectId: number): string {
  return `?tab=planning&project=${encodeURIComponent(project)}&pp=${planningProjectId}`;
}

function recentDuplicateExists(
  db: Database,
  userId: string,
  kind: string,
  wishId: number,
  windowMs: number,
): boolean {
  const cutoff = Date.now() - windowMs;
  const row = db
    .prepare(
      `SELECT 1 FROM notifications
        WHERE user_id = ? AND kind = ? AND message_id = ?
          AND created_at > ?
          AND read_at IS NULL
        LIMIT 1`,
    )
    .get(userId, kind, wishId, cutoff) as { 1?: number } | undefined;
  return !!row;
}

export interface NotifyAssignmentOpts {
  db: Database;
  queue: BunnyQueue;
  project: string;
  planningProjectId: number;
  wishId: number;
  wishTitle: string;
  newTeamId: number;
  newTeamName: string;
  actorUserId: string;
}

export function notifyTeamAssignment(opts: NotifyAssignmentOpts): void {
  const recipients = listTeamMembers(opts.db, opts.newTeamId).filter(
    (uid) => uid !== opts.actorUserId,
  );
  if (recipients.length === 0) return;
  const deepLink = buildDeepLink(opts.project, opts.planningProjectId);
  for (const userId of recipients) {
    try {
      const notif = createNotification(opts.db, {
        userId,
        kind: "planning.wish.assigned",
        title: `New work for ${opts.newTeamName}`,
        body: `Wish "${opts.wishTitle}" has been assigned to your team.`,
        actorUserId: opts.actorUserId,
        project: opts.project,
        messageId: opts.wishId,
        deepLink,
      });
      void opts.queue.log({
        topic: "planning",
        kind: "notification.assigned",
        userId,
        data: {
          wishId: opts.wishId,
          teamId: opts.newTeamId,
          notifId: notif.id,
        },
      });
      publishToUser(userId, notif);
    } catch (err) {
      void opts.queue.log({
        topic: "planning",
        kind: "notification.assigned.error",
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export interface NotifyDeadlineConflictOpts {
  db: Database;
  queue: BunnyQueue;
  project: string;
  planningProjectId: number;
  wishId: number;
  wishTitle: string;
  teamId: number | null;
  deadlineName: string;
  deadlineDueDate: string;
  plannedEndDate: string;
  actorUserId: string;
  /** Window for de-duplication. */
  dedupWindowMs: number;
  /** Admins reachable via the project; pass IDs already filtered. */
  adminUserIds: string[];
}

export function notifyDeadlineConflict(opts: NotifyDeadlineConflictOpts): void {
  const teamMembers =
    opts.teamId !== null ? listTeamMembers(opts.db, opts.teamId) : [];
  const recipients = Array.from(
    new Set([...teamMembers, ...opts.adminUserIds]),
  ).filter((uid) => uid !== opts.actorUserId);
  if (recipients.length === 0) return;

  const deepLink = buildDeepLink(opts.project, opts.planningProjectId);
  const body =
    `Wish "${opts.wishTitle}" planned end ${opts.plannedEndDate} ` +
    `exceeds deadline "${opts.deadlineName}" (${opts.deadlineDueDate}).`;

  for (const userId of recipients) {
    if (
      recentDuplicateExists(
        opts.db,
        userId,
        "planning.deadline.conflict",
        opts.wishId,
        opts.dedupWindowMs,
      )
    ) {
      continue;
    }
    try {
      const notif = createNotification(opts.db, {
        userId,
        kind: "planning.deadline.conflict",
        title: `Deadline at risk: ${opts.deadlineName}`,
        body,
        actorUserId: opts.actorUserId,
        project: opts.project,
        messageId: opts.wishId,
        deepLink,
      });
      void opts.queue.log({
        topic: "planning",
        kind: "notification.deadline_conflict",
        userId,
        data: {
          wishId: opts.wishId,
          deadlineDueDate: opts.deadlineDueDate,
          plannedEndDate: opts.plannedEndDate,
          notifId: notif.id,
        },
      });
      publishToUser(userId, notif);
    } catch (err) {
      void opts.queue.log({
        topic: "planning",
        kind: "notification.deadline_conflict.error",
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
