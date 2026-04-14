/**
 * Message persistence — insert and retrieve conversation messages.
 */

import type { Database } from "bun:sqlite";

export type MessageRole = "system" | "user" | "assistant" | "tool";
export type MessageChannel = "content" | "reasoning" | "tool_call" | "tool_result";

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
}

export function insertMessage(db: Database, opts: InsertMessageOpts): number {
  const stmt = db.prepare(`
    INSERT INTO messages (session_id, ts, role, channel, content, tool_call_id, tool_name, provider_sig, ok, duration_ms, prompt_tokens, completion_tokens, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `);
  const row = stmt.get(
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
  ) as { id: number } | undefined;
  return row?.id ?? 0;
}

export function getMessagesBySession(db: Database, sessionId: string): StoredMessage[] {
  const rows = db
    .prepare(
      `SELECT m.id, m.session_id, m.ts, m.role, m.channel, m.content, m.tool_call_id,
              m.tool_name, m.provider_sig, m.ok, m.duration_ms, m.prompt_tokens,
              m.completion_tokens, m.user_id,
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
    username: r.username,
    displayName: r.display_name,
  }));
}
