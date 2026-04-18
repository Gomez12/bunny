/**
 * Hide Quick Chats whose newest non-trimmed message is older than the
 * inactivity threshold. The user can recover them via "Show hidden".
 */

import type { Database } from "bun:sqlite";
import { setSessionHiddenFromChat } from "../../memory/session_visibility.ts";
import type { HandlerRegistry, TaskHandlerContext } from "../handlers.ts";

export const QUICK_CHAT_HIDE_HANDLER = "session.hide_inactive_quick_chats";

const DEFAULT_INACTIVITY_MS = 15 * 60 * 1000;

interface HiddenRow {
  user_id: string;
  session_id: string;
}

export function selectAndHideInactive(
  db: Database,
  now: number,
  inactivityMs: number,
): HiddenRow[] {
  const cutoff = now - inactivityMs;
  // EXISTS guard prevents a freshly-created (empty) Quick Chat from being
  // hidden on the very first tick.
  const rows = db
    .prepare(
      `SELECT sv.user_id AS user_id, sv.session_id AS session_id
         FROM session_visibility sv
        WHERE sv.is_quick_chat = 1
          AND sv.hidden_from_chat = 0
          AND EXISTS (
            SELECT 1 FROM messages m
             WHERE m.session_id = sv.session_id
               AND m.trimmed_at IS NULL
          )
          AND NOT EXISTS (
            SELECT 1 FROM messages m
             WHERE m.session_id = sv.session_id
               AND m.trimmed_at IS NULL
               AND m.ts > ?
          )`,
    )
    .all(cutoff) as HiddenRow[];
  if (rows.length === 0) return rows;
  const txn = db.transaction(() => {
    for (const r of rows) setSessionHiddenFromChat(db, r.user_id, r.session_id, true);
  });
  txn();
  return rows;
}

export async function quickChatHideHandler(
  ctx: TaskHandlerContext,
): Promise<void> {
  const { db, queue, task, payload, now } = ctx;
  const ms =
    payload && typeof payload === "object" && "inactivityMs" in payload
      ? (payload as { inactivityMs?: unknown }).inactivityMs
      : undefined;
  const inactivityMs =
    typeof ms === "number" && ms > 0 ? ms : DEFAULT_INACTIVITY_MS;
  const hidden = selectAndHideInactive(db, now, inactivityMs);
  if (hidden.length === 0) return;
  for (const r of hidden) {
    void queue.log({
      topic: "session",
      kind: "auto_hide",
      userId: r.user_id,
      data: { sessionId: r.session_id, taskId: task.id, inactivityMs },
    });
  }
}

export function registerQuickChatHide(registry: HandlerRegistry): void {
  registry.register(QUICK_CHAT_HIDE_HANDLER, quickChatHideHandler);
}
