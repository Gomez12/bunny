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
}

const INSERT_MESSAGE_SQL = `
    INSERT INTO messages (session_id, ts, role, channel, content, tool_call_id, tool_name, provider_sig, ok, duration_ms, prompt_tokens, completion_tokens, user_id, project, author, attachments)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    "session_id = ? AND channel = 'content' AND role IN ('user', 'assistant') AND content IS NOT NULL AND content != ''";
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

export function getMessagesBySession(
  db: Database,
  sessionId: string,
): StoredMessage[] {
  const rows = db
    .prepare(
      `SELECT m.id, m.session_id, m.ts, m.role, m.channel, m.content, m.tool_call_id,
              m.tool_name, m.provider_sig, m.ok, m.duration_ms, m.prompt_tokens,
              m.completion_tokens, m.user_id, COALESCE(m.project, 'general') AS project,
              m.author AS author, m.attachments AS attachments,
              u.username AS username, u.display_name AS display_name
       FROM messages m
       LEFT JOIN users u ON u.id = m.user_id
       WHERE m.session_id = ? ORDER BY m.ts ASC`,
    )
    .all(sessionId) as Array<{
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
    username: string | null;
    display_name: string | null;
  }>;
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
    username: r.username,
    displayName: r.display_name,
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
