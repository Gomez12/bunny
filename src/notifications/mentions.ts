/**
 * User mention detection and notification dispatch.
 *
 * Unlike the leading `@agent` dispatcher in `src/agent/mention.ts`, this
 * scanner walks the whole prompt and emits one notification per distinct
 * recipient. Decisions and edge cases are captured in ADR 0027 — summary:
 *
 * - Boundary rule: `@` at start-of-string OR preceded by a char not in
 *   `[A-Za-z0-9_:/.@-]`. Rules out emails (`foo@bar.com`), URLs
 *   (`https://x.com/@alice`), `cc:@user`, `path/@user`.
 * - Trailing boundary: end-of-string OR a char not in `[A-Za-z0-9_-]`.
 * - Fenced ```…``` blocks and inline `…` code spans are stripped before
 *   scanning so mentions buried in code samples don't fire.
 * - Lookup is case-insensitive; the return list is lower-cased and deduped.
 */

import type { Database } from "bun:sqlite";
import { AGENT_NAME_RE } from "../memory/agent_name.ts";
import { getUserByUsernameCI, type User } from "../auth/users.ts";
import { getProject, type Project } from "../memory/projects.ts";
import { createNotification } from "../memory/notifications.ts";
import type { BunnyQueue } from "../queue/bunqueue.ts";

// Reuse the agent-name body (case-insensitive) and wrap with boundary rules.
const MENTION_RE = new RegExp(
  `(?:^|[^A-Za-z0-9_:/.@\\-])@(${AGENT_NAME_RE.source.replace(
    /^\^|\$$/g,
    "",
  )})(?![A-Za-z0-9_\\-])`,
  "gi",
);

/** Strip fenced ```…``` blocks and inline `…` code spans. */
function stripCode(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ");
}

/**
 * Return the unique, lower-cased usernames referenced via `@name` in `text`.
 * Order is stable (first-appearance).
 */
export function parseUserMentions(text: string): string[] {
  if (typeof text !== "string" || text.length === 0) return [];
  const cleaned = stripCode(text);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of cleaned.matchAll(MENTION_RE)) {
    const name = match[1]?.toLowerCase();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

function canSeeProject(p: Project, user: User): boolean {
  if (p.visibility === "public") return true;
  if (user.role === "admin") return true;
  return p.createdBy === user.id;
}

export interface DispatchDeps {
  /** Broadcast a freshly-created notification to the recipient's live SSE subscribers. */
  publish?: (userId: string, notificationId: number) => void;
}

export interface DispatchMentionOpts {
  db: Database;
  queue: BunnyQueue;
  project: string;
  sessionId: string;
  messageId: number;
  /** The user who typed the message containing mentions. */
  sender: User;
  /** Raw user prompt — mentions inside code spans are ignored. */
  rawPrompt: string;
  deps?: DispatchDeps;
}

export interface DispatchResult {
  deliveredTo: string[]; // recipient user ids
  blockedUsernames: string[]; // display form (original stored casing where possible)
  unknownUsernames: string[]; // not in users table
}

function buildDeepLink(
  project: string,
  sessionId: string,
  messageId: number,
): string {
  return `?tab=chat&project=${encodeURIComponent(project)}&session=${encodeURIComponent(
    sessionId,
  )}#m${messageId}`;
}

function senderLabel(sender: User): string {
  return sender.displayName?.trim() || sender.username;
}

/**
 * Scan `rawPrompt` for `@username` mentions and create notifications.
 *
 * - Self-mentions are skipped.
 * - Unknown usernames are dropped silently.
 * - For recipients who can see the project: a `mention` row is created and the
 *   `publish` callback is invoked so their live SSE subscribers see it.
 * - For recipients who cannot see the project: nothing is created for them; a
 *   single aggregated `mention_blocked` row is written to the sender listing
 *   all blocked usernames.
 *
 * Errors are swallowed and logged via the queue; dispatching notifications
 * must never break the main chat flow.
 */
export function dispatchMentionNotifications(
  opts: DispatchMentionOpts,
): DispatchResult {
  const result: DispatchResult = {
    deliveredTo: [],
    blockedUsernames: [],
    unknownUsernames: [],
  };
  const candidates = parseUserMentions(opts.rawPrompt);
  if (candidates.length === 0) return result;

  const project = getProject(opts.db, opts.project);
  if (!project) {
    // Unknown project — silent no-op. Caller validated the project before
    // reaching the agent loop; arriving here means a race with deletion.
    return result;
  }

  const deepLink = buildDeepLink(opts.project, opts.sessionId, opts.messageId);
  const senderName = senderLabel(opts.sender);

  for (const candidate of candidates) {
    const recipient = getUserByUsernameCI(opts.db, candidate);
    if (!recipient) {
      result.unknownUsernames.push(candidate);
      continue;
    }
    if (recipient.id === opts.sender.id) continue;

    if (!canSeeProject(project, recipient)) {
      // Record the original casing (from users.username) for the counter-row
      // body so the sender sees exactly the name they typed.
      result.blockedUsernames.push(recipient.username);
      continue;
    }

    try {
      const notif = createNotification(opts.db, {
        userId: recipient.id,
        kind: "mention",
        title: `${senderName} mentioned you`,
        body: opts.rawPrompt.slice(0, 500),
        actorUserId: opts.sender.id,
        actorUsername: opts.sender.username,
        actorDisplayName: opts.sender.displayName,
        project: opts.project,
        sessionId: opts.sessionId,
        messageId: opts.messageId,
        deepLink,
      });
      result.deliveredTo.push(recipient.id);
      void opts.queue.log({
        topic: "notification",
        kind: "create",
        userId: recipient.id,
        sessionId: opts.sessionId,
        data: {
          notifId: notif.id,
          kind: notif.kind,
          senderId: opts.sender.id,
          project: opts.project,
        },
      });
      opts.deps?.publish?.(recipient.id, notif.id);
    } catch (err) {
      void opts.queue.log({
        topic: "notification",
        kind: "create.error",
        userId: recipient.id,
        sessionId: opts.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (result.blockedUsernames.length > 0) {
    try {
      const listed = result.blockedUsernames.map((n) => `@${n}`).join(", ");
      const title =
        result.blockedUsernames.length === 1
          ? `Mention not delivered to @${result.blockedUsernames[0]}`
          : `Mentions not delivered`;
      const notif = createNotification(opts.db, {
        userId: opts.sender.id,
        kind: "mention_blocked",
        title,
        body: `${listed} cannot see project "${opts.project}", so your mention was not delivered.`,
        actorUserId: opts.sender.id,
        actorUsername: opts.sender.username,
        actorDisplayName: opts.sender.displayName,
        project: opts.project,
        sessionId: opts.sessionId,
        messageId: opts.messageId,
        deepLink,
      });
      void opts.queue.log({
        topic: "notification",
        kind: "create",
        userId: opts.sender.id,
        sessionId: opts.sessionId,
        data: {
          notifId: notif.id,
          kind: notif.kind,
          blocked: result.blockedUsernames,
          project: opts.project,
        },
      });
      opts.deps?.publish?.(opts.sender.id, notif.id);
    } catch (err) {
      void opts.queue.log({
        topic: "notification",
        kind: "create.error",
        userId: opts.sender.id,
        sessionId: opts.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}
