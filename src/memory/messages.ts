/**
 * Message persistence — insert and retrieve conversation messages.
 */

import type { Database } from "bun:sqlite";
import type { ChatAttachment, ChatMessage } from "../llm/types.ts";
import { prep } from "./prepared.ts";
import { invalidateSessionOwners } from "./sessions.ts";

export type MessageRole = "system" | "user" | "assistant" | "tool";
export type MessageChannel =
  | "content"
  | "reasoning"
  | "tool_call"
  | "tool_result";

export interface StoredMessage {
  id: number;
  sessionId: string;
  ts: number;
  role: MessageRole;
  channel: MessageChannel;
  content: string | null;
  toolCallId: string | null;
  toolName: string | null;
  providerSig: string | null;
  /** Only populated on tool_result rows (1 = success, 0 = failure). */
  ok: boolean | null;
  /** LLM-call stats — only set on assistant content/reasoning rows. */
  durationMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  /** Owner of the message (null for legacy rows). */
  userId: string | null;
  username: string | null;
  displayName: string | null;
  /** Owning project ('general' for legacy/null rows). */
  project: string;
  /** Responding agent name, or null for the default assistant / user rows. */
  author: string | null;
  /** User-turn attachments (images). Null when absent. */
  attachments: ChatAttachment[] | null;
  /** Unix ms when this message was edited via the edit affordance (null = never). */
  editedAt: number | null;
  /**
   * For an assistant message that was produced by clicking "Regenerate", the
   * id of the original message it is an alternate version of. NULL when this
   * is the chain's root.
   */
  regenOfMessageId: number | null;
  /**
   * Ordered list of all versions in this regen chain (root first), populated
   * by getMessagesBySession. Each entry carries the version's content so the
   * UI can flip between alternates without an extra round-trip. Length 1 =
   * no regens.
   */
  regenChain: Array<{ id: number; ts: number; content: string | null }>;
}

export interface InsertMessageOpts {
  sessionId: string;
  role: MessageRole;
  channel?: MessageChannel;
  content: string | null;
  toolCallId?: string;
  toolName?: string;
  providerSig?: string;
  ok?: boolean;
  durationMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  userId?: string | null;
  /** Owning project name. Defaults to 'general' when omitted. */
  project?: string | null;
  /** Responding agent name. Null for the default assistant or user turns. */
  author?: string | null;
  /** Attachments (images) for user turns. */
  attachments?: ChatAttachment[] | null;
  /**
   * For assistant messages produced via "Regenerate", the id of the original
   * message in the chain. NULL for everything else.
   */
  regenOfMessageId?: number | null;
  /**
   * 1 when this row was produced by a scheduled / background `runAgent` call
   * (web-news, board card runs, kb auto-generate, contact/business soul
   * refresh, business auto-build, translation, memory.refresh itself). The
   * memory.refresh handler ignores rows with this flag set so it does not
   * keep merging its own automation output back into user/agent memory.
   */
  fromAutomation?: boolean;
}

const INSERT_MESSAGE_SQL = `
    INSERT INTO messages (session_id, ts, role, channel, content, tool_call_id, tool_name, provider_sig, ok, duration_ms, prompt_tokens, completion_tokens, user_id, project, author, attachments, regen_of_message_id, from_automation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `;

export function insertMessage(db: Database, opts: InsertMessageOpts): number {
  const row = prep(db, INSERT_MESSAGE_SQL).get(
    opts.sessionId,
    Date.now(),
    opts.role,
    opts.channel ?? "content",
    opts.content,
    opts.toolCallId ?? null,
    opts.toolName ?? null,
    opts.providerSig ?? null,
    opts.ok === undefined ? null : opts.ok ? 1 : 0,
    opts.durationMs ?? null,
    opts.promptTokens ?? null,
    opts.completionTokens ?? null,
    opts.userId ?? null,
    opts.project ?? "general",
    opts.author ?? null,
    opts.attachments && opts.attachments.length > 0
      ? JSON.stringify(opts.attachments)
      : null,
    opts.regenOfMessageId ?? null,
    opts.fromAutomation ? 1 : 0,
  ) as { id: number } | undefined;
  if (opts.userId) invalidateSessionOwners(db, opts.sessionId);
  return row?.id ?? 0;
}

/**
 * Return the last `limit` user/assistant *content* messages of a session in
 * chronological (oldest-first) order, ready to be spliced into a ChatRequest
 * as verbatim conversation history. Tool-call / tool-result / reasoning rows
 * are deliberately excluded — they belong to already-completed inner loops
 * and replaying them without their siblings confuses the LLM.
 *
 * The returned array never includes rows with NULL content. Each message is
 * tagged with its DB id on a non-standard `messageId` property so callers can
 * de-duplicate against recall results.
 */
export function getRecentTurns(
  db: Database,
  sessionId: string,
  limit: number,
  /**
   * When set, restrict assistant rows to those authored by `ownAuthor`
   * (or by the default assistant when `ownAuthor` is null). User turns are
   * always included so the agent can still see what was asked.
   */
  ownAuthor?: string | null | undefined,
): Array<ChatMessage & { messageId: number }> {
  if (limit <= 0) return [];
  const baseClauses =
    "session_id = ? AND channel = 'content' AND role IN ('user', 'assistant') AND content IS NOT NULL AND content != '' AND trimmed_at IS NULL";
  const params: (string | number | null)[] = [sessionId];
  let sql: string;
  if (ownAuthor !== undefined) {
    sql = `SELECT id, role, content, attachments FROM messages
           WHERE ${baseClauses} AND (role = 'user' OR (role = 'assistant' AND author IS ?))
           ORDER BY ts DESC, id DESC
           LIMIT ?`;
    params.push(ownAuthor);
  } else {
    sql = `SELECT id, role, content, attachments FROM messages
           WHERE ${baseClauses}
           ORDER BY ts DESC, id DESC
           LIMIT ?`;
  }
  params.push(limit);
  const rows = prep(db, sql).all(...params) as Array<{
    id: number;
    role: string;
    content: string;
    attachments: string | null;
  }>;
  return rows.reverse().map((r) => {
    const parsed = parseAttachments(r.attachments);
    const msg: ChatMessage & { messageId: number } = {
      role: r.role as "user" | "assistant",
      content: r.content,
      messageId: r.id,
    };
    if (parsed && parsed.length > 0) msg.attachments = parsed;
    return msg;
  });
}

export interface GetMessagesBySessionOpts {
  /**
   * Cap on the number of returned rows. When set, returns the **most recent**
   * `limit` rows (by `id` DESC) and re-orders them ascending before return.
   * Hard-capped at 5000 to keep one request from materialising an enormous
   * heap allocation.
   */
  limit?: number;
  /**
   * Cursor: only return rows with `id < beforeId`. Combine with `limit` to
   * page backwards in chunks (oldest-first within each page). Returned rows
   * are still in ascending order so the caller can splice them onto the
   * front of an existing list without re-sorting.
   */
  beforeId?: number;
}

export function getMessagesBySession(
  db: Database,
  sessionId: string,
  opts: GetMessagesBySessionOpts = {},
): StoredMessage[] {
  const clauses = ["m.session_id = ?", "m.trimmed_at IS NULL"];
  const params: (string | number)[] = [sessionId];

  if (typeof opts.beforeId === "number" && opts.beforeId > 0) {
    clauses.push("m.id < ?");
    params.push(opts.beforeId);
  }

  let orderClause = "ORDER BY m.ts ASC";
  let limitClause = "";
  let needReverse = false;
  if (typeof opts.limit === "number" && opts.limit > 0) {
    // Pull the latest N via id DESC + LIMIT, then reverse on the JS side so
    // the caller still gets chronological order.
    orderClause = "ORDER BY m.id DESC";
    limitClause = "LIMIT ?";
    params.push(Math.min(opts.limit, 5000));
    needReverse = true;
  }

  const rows = db
    .prepare(
      `SELECT m.id, m.session_id, m.ts, m.role, m.channel, m.content, m.tool_call_id,
              m.tool_name, m.provider_sig, m.ok, m.duration_ms, m.prompt_tokens,
              m.completion_tokens, m.user_id, COALESCE(m.project, 'general') AS project,
              m.author AS author, m.attachments AS attachments,
              m.edited_at AS edited_at, m.regen_of_message_id AS regen_of_message_id,
              u.username AS username, u.display_name AS display_name
       FROM messages m
       LEFT JOIN users u ON u.id = m.user_id
       WHERE ${clauses.join(" AND ")} ${orderClause} ${limitClause}`,
    )
    .all(...params) as Array<{
    id: number;
    session_id: string;
    ts: number;
    role: string;
    channel: string;
    content: string | null;
    tool_call_id: string | null;
    tool_name: string | null;
    provider_sig: string | null;
    ok: number | null;
    duration_ms: number | null;
    prompt_tokens: number | null;
    completion_tokens: number | null;
    user_id: string | null;
    project: string;
    author: string | null;
    attachments: string | null;
    edited_at: number | null;
    regen_of_message_id: number | null;
    username: string | null;
    display_name: string | null;
  }>;
  if (needReverse) rows.reverse();
  const chains = buildRegenChains(rows);
  return rows.map((r) => ({
    id: r.id,
    sessionId: r.session_id,
    ts: r.ts,
    role: r.role as MessageRole,
    channel: r.channel as MessageChannel,
    content: r.content,
    toolCallId: r.tool_call_id,
    toolName: r.tool_name,
    providerSig: r.provider_sig,
    ok: r.ok === null ? null : r.ok === 1,
    durationMs: r.duration_ms,
    promptTokens: r.prompt_tokens,
    completionTokens: r.completion_tokens,
    userId: r.user_id,
    project: r.project,
    author: r.author,
    attachments: parseAttachments(r.attachments),
    editedAt: r.edited_at,
    regenOfMessageId: r.regen_of_message_id,
    regenChain: chains.get(r.id) ?? [
      { id: r.id, ts: r.ts, content: r.content },
    ],
    username: r.username,
    displayName: r.display_name,
  }));
}

/** Map each row id to the ordered list of versions in its regen chain (root first). */
function buildRegenChains(
  rows: Array<{
    id: number;
    ts: number;
    content: string | null;
    regen_of_message_id: number | null;
  }>,
): Map<number, Array<{ id: number; ts: number; content: string | null }>> {
  const childrenByRoot = new Map<
    number,
    Array<{ id: number; ts: number; content: string | null }>
  >();
  const rowById = new Map(rows.map((r) => [r.id, r] as const));

  // Find the chain root for a given row (climb regen_of pointers).
  const rootOf = (id: number): number => {
    let cur = id;
    const seen = new Set<number>();
    for (;;) {
      if (seen.has(cur)) return cur; // cycle guard
      seen.add(cur);
      const row = rowById.get(cur);
      if (!row || row.regen_of_message_id == null) return cur;
      cur = row.regen_of_message_id;
    }
  };

  for (const r of rows) {
    const root = rootOf(r.id);
    let arr = childrenByRoot.get(root);
    if (!arr) {
      arr = [];
      childrenByRoot.set(root, arr);
    }
    arr.push({ id: r.id, ts: r.ts, content: r.content });
  }

  // Sort each chain by ts (ascending) so the root is first, latest is last.
  for (const arr of childrenByRoot.values()) {
    arr.sort((a, b) => a.ts - b.ts || a.id - b.id);
  }

  // Propagate the chain to every member id.
  const out = new Map<
    number,
    Array<{ id: number; ts: number; content: string | null }>
  >();
  for (const r of rows) {
    out.set(
      r.id,
      childrenByRoot.get(rootOf(r.id)) ?? [
        { id: r.id, ts: r.ts, content: r.content },
      ],
    );
  }
  return out;
}

/** Rewrite a message's content and stamp `edited_at`. ACL is the caller's job. */
export function editMessageContent(
  db: Database,
  messageId: number,
  newContent: string,
): void {
  db.prepare(`UPDATE messages SET content = ?, edited_at = ? WHERE id = ?`).run(
    newContent,
    Date.now(),
    messageId,
  );
}

/**
 * Soft-delete every message in `sessionId` whose `id` is strictly greater
 * than the pivot message's `id`. We compare on `id` (autoincrement, strictly
 * monotonic) rather than `ts`, because messages inserted in the same
 * millisecond share a timestamp and a `ts > pivot.ts` predicate would skip
 * them. Returns the count of trimmed rows. The pivot row itself is NOT
 * trimmed. Idempotent: rows already trimmed are skipped.
 *
 * RETURNING is preferred over `result.changes` because the FTS5 trim trigger
 * cascades writes into `messages_fts` that inflate sqlite3_changes().
 */
export function trimSessionAfter(
  db: Database,
  sessionId: string,
  pivotMessageId: number,
): { trimmedCount: number } {
  const rows = db
    .prepare(
      `UPDATE messages SET trimmed_at = ?
         WHERE session_id = ? AND id > ? AND trimmed_at IS NULL
       RETURNING id`,
    )
    .all(Date.now(), sessionId, pivotMessageId) as Array<{ id: number }>;
  return { trimmedCount: rows.length };
}

/**
 * Look up the owning user_id for a message, or null when the row is anonymous
 * (legacy) or does not exist.
 */
export function getMessageOwner(
  db: Database,
  messageId: number,
): { sessionId: string; userId: string | null; role: MessageRole } | null {
  const row = db
    .prepare(
      `SELECT session_id, user_id, role FROM messages WHERE id = ? AND trimmed_at IS NULL`,
    )
    .get(messageId) as
    | { session_id: string; user_id: string | null; role: string }
    | undefined;
  if (!row) return null;
  return {
    sessionId: row.session_id,
    userId: row.user_id,
    role: row.role as MessageRole,
  };
}

/**
 * Find the most recent user-content message in `sessionId` whose `id` is
 * strictly less than `pivotMessageId`. Used by regenerate to recover the
 * prompt that produced the assistant message we are regenerating from. We
 * order by `id` rather than `ts` to handle messages inserted in the same
 * millisecond deterministically.
 */
export function findPriorUserMessage(
  db: Database,
  sessionId: string,
  pivotMessageId: number,
): { id: number; content: string; ts: number } | null {
  const row = db
    .prepare(
      `SELECT id, content, ts FROM messages
         WHERE session_id = ? AND role = 'user' AND channel = 'content'
           AND content IS NOT NULL AND content != ''
           AND trimmed_at IS NULL
           AND id < ?
         ORDER BY id DESC LIMIT 1`,
    )
    .get(sessionId, pivotMessageId) as
    | { id: number; content: string; ts: number }
    | undefined;
  return row ?? null;
}

/**
 * Find the author of the first assistant content row after `afterMessageId`
 * in `sessionId`. Used by regenerate on a user target to inherit the agent
 * that originally answered this prompt. Returns null when no subsequent
 * assistant row exists.
 */
export function findNextAssistantAuthor(
  db: Database,
  sessionId: string,
  afterMessageId: number,
): string | null {
  const row = db
    .prepare(
      `SELECT author FROM messages
         WHERE session_id = ? AND role = 'assistant' AND channel = 'content'
           AND id > ?
         ORDER BY id ASC LIMIT 1`,
    )
    .get(sessionId, afterMessageId) as { author: string | null } | undefined;
  return row?.author ?? null;
}

/**
 * Permission check for message edit / trim / regenerate. Admins always pass;
 * otherwise the caller must own the message. Anonymous (legacy) rows have no
 * owner and can only be touched by admins. Mirrors `canEditCard` /
 * `canEditDocument`.
 */
export function canEditMessage(
  ownerId: string | null,
  user: { id: string; role: string },
): boolean {
  if (user.role === "admin") return true;
  if (ownerId === null) return false;
  return ownerId === user.id;
}

/**
 * Compact projection of a content message for the memory.refresh handler. We
 * select id + ts + role + author + content only — attachments and tool rows
 * are explicitly skipped so the analyser sees plain text deltas without
 * having to filter them out itself.
 */
export interface MemoryRefreshMessage {
  id: number;
  ts: number;
  role: "user" | "assistant";
  author: string | null;
  content: string;
}

interface MemoryRefreshRow {
  id: number;
  ts: number;
  role: string;
  author: string | null;
  content: string | null;
}

/**
 * Content messages authored by a user inside a project, after the watermark.
 * Only `role IN ('user','assistant')` rows on the `content` channel — tool
 * calls, tool results, and reasoning are filtered out.
 *
 * NOTE: bunny stamps `user_id` on assistant rows too (the user owning the
 * session), so this returns both halves of the conversation. That matches
 * what we want for user-memory: facts the user expressed AND facts the
 * assistant established about them.
 */
export function getUserProjectMessagesAfter(
  db: Database,
  userId: string,
  project: string,
  afterMessageId: number,
  limit: number,
): MemoryRefreshMessage[] {
  if (limit <= 0) return [];
  const rows = prep(
    db,
    `SELECT id, ts, role, author, content FROM messages
       WHERE user_id = ?
         AND COALESCE(project, 'general') = ?
         AND id > ?
         AND channel = 'content'
         AND role IN ('user', 'assistant')
         AND content IS NOT NULL AND content != ''
         AND trimmed_at IS NULL
         AND from_automation = 0
       ORDER BY id ASC
       LIMIT ?`,
  ).all(userId, project, afterMessageId, limit) as MemoryRefreshRow[];
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    role: r.role as "user" | "assistant",
    author: r.author,
    content: r.content!,
  }));
}

/**
 * All content messages from sessions in `project` where the named agent ever
 * authored an assistant turn, after the watermark. Returns both user prompts
 * and assistant replies so the analyser can see the full conversation the
 * agent participated in. Tool rows / reasoning are dropped.
 */
export function getProjectAgentMessagesAfter(
  db: Database,
  agent: string,
  project: string,
  afterMessageId: number,
  limit: number,
): MemoryRefreshMessage[] {
  if (limit <= 0) return [];
  const rows = prep(
    db,
    `SELECT id, ts, role, author, content FROM messages
       WHERE COALESCE(project, 'general') = ?
         AND id > ?
         AND channel = 'content'
         AND role IN ('user', 'assistant')
         AND content IS NOT NULL AND content != ''
         AND trimmed_at IS NULL
         AND from_automation = 0
         AND session_id IN (
           SELECT DISTINCT session_id FROM messages
           WHERE author = ? AND COALESCE(project, 'general') = ?
             AND from_automation = 0
         )
       ORDER BY id ASC
       LIMIT ?`,
  ).all(project, afterMessageId, agent, project, limit) as MemoryRefreshRow[];
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    role: r.role as "user" | "assistant",
    author: r.author,
    content: r.content!,
  }));
}

/**
 * Recent content messages by a user across every project — used for soul
 * refresh, where personality observations cut across project context.
 */
export function getUserMessagesAfter(
  db: Database,
  userId: string,
  afterMessageId: number,
  limit: number,
): MemoryRefreshMessage[] {
  if (limit <= 0) return [];
  const rows = prep(
    db,
    `SELECT id, ts, role, author, content FROM messages
       WHERE user_id = ?
         AND id > ?
         AND channel = 'content'
         AND role IN ('user', 'assistant')
         AND content IS NOT NULL AND content != ''
         AND trimmed_at IS NULL
         AND from_automation = 0
       ORDER BY id ASC
       LIMIT ?`,
  ).all(userId, afterMessageId, limit) as MemoryRefreshRow[];
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    role: r.role as "user" | "assistant",
    author: r.author,
    content: r.content!,
  }));
}

function parseAttachments(raw: string | null): ChatAttachment[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ChatAttachment[];
    if (Array.isArray(parsed)) return parsed;
  } catch {
    /* fall through */
  }
  return null;
}
