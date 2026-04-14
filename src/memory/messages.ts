/**
 * Message persistence — insert and retrieve conversation messages.
 */

import type { Database } from "bun:sqlite";

export type MessageRole = "system" | "user" | "assistant" | "tool";
export type MessageChannel = "content" | "reasoning" | "tool_result";

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
}

export interface InsertMessageOpts {
  sessionId: string;
  role: MessageRole;
  channel?: MessageChannel;
  content: string | null;
  toolCallId?: string;
  toolName?: string;
  providerSig?: string;
}

export function insertMessage(db: Database, opts: InsertMessageOpts): number {
  const stmt = db.prepare(`
    INSERT INTO messages (session_id, ts, role, channel, content, tool_call_id, tool_name, provider_sig)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
  ) as { id: number } | undefined;
  return row?.id ?? 0;
}

export function getMessagesBySession(db: Database, sessionId: string): StoredMessage[] {
  const rows = db
    .prepare(
      `SELECT id, session_id, ts, role, channel, content, tool_call_id, tool_name, provider_sig
       FROM messages WHERE session_id = ? ORDER BY ts ASC`,
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
  }));
}
