/**
 * Telegram Bot API client.
 *
 * Thin wrapper around `fetch` that knows enough about Telegram's response
 * envelope (`{ ok, result, description, error_code }`) to throw on failure.
 * All outbound calls go through `acquireTelegramSlot` first — the 30/s global
 * limit and 1/s-per-chat limit are painful to hit silently.
 *
 * Only the handful of endpoints we actually use is implemented:
 *   - `getMe`
 *   - `getUpdates`
 *   - `sendMessage`   (with HTML parse_mode)
 *   - `sendDocument`  (long-text fallback)
 *   - `setWebhook`
 *   - `deleteWebhook`
 *
 * Callers pass the bot token explicitly so this module stays stateless — a
 * per-project token is the norm, not the exception.
 */

import { acquireTelegramSlot } from "./rate_limit.ts";
import type { TgMeResponse, TgUpdate } from "./types.ts";
import { tokenTail } from "./util.ts";

const API_BASE = "https://api.telegram.org";

export class TelegramApiError extends Error {
  code: number;
  description: string;
  retryAfter: number | null;
  constructor(code: number, description: string, retryAfter: number | null) {
    super(`Telegram API ${code}: ${description}`);
    this.code = code;
    this.description = description;
    this.retryAfter = retryAfter;
  }
}

interface TgEnvelope<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

async function call<T>(
  token: string,
  method: string,
  body: unknown,
  opts: { chatId?: number; skipRateLimit?: boolean } = {},
): Promise<T> {
  if (!opts.skipRateLimit) {
    await acquireTelegramSlot({
      tokenTail: tokenTail(token),
      chatId: opts.chatId,
    });
  }
  const url = `${API_BASE}/bot${token}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const env = (await res.json()) as TgEnvelope<T>;
  if (!env.ok) {
    throw new TelegramApiError(
      env.error_code ?? res.status ?? 0,
      env.description ?? res.statusText,
      env.parameters?.retry_after ?? null,
    );
  }
  return env.result as T;
}

export async function getMe(token: string): Promise<TgMeResponse> {
  return call<TgMeResponse>(token, "getMe", undefined, { skipRateLimit: true });
}

export interface GetUpdatesOpts {
  offset?: number;
  limit?: number;
  timeout?: number;
  allowed_updates?: string[];
}

export async function getUpdates(
  token: string,
  opts: GetUpdatesOpts = {},
): Promise<TgUpdate[]> {
  // Polling calls are NOT rate-limited against sendMessage — they have their
  // own budget and would starve the bucket.
  return call<TgUpdate[]>(
    token,
    "getUpdates",
    {
      offset: opts.offset,
      limit: opts.limit ?? 50,
      timeout: opts.timeout ?? 0,
      allowed_updates: opts.allowed_updates ?? ["message"],
    },
    { skipRateLimit: true },
  );
}

export interface SendMessageOpts {
  chat_id: number;
  text: string;
  parse_mode?: "HTML" | "MarkdownV2";
  disable_web_page_preview?: boolean;
  disable_notification?: boolean;
  reply_to_message_id?: number;
}

export async function sendMessage(
  token: string,
  opts: SendMessageOpts,
): Promise<{ message_id: number }> {
  return call<{ message_id: number }>(token, "sendMessage", opts, {
    chatId: opts.chat_id,
  });
}

export interface SendDocumentOpts {
  chat_id: number;
  filename: string;
  content: string;
  mime?: string;
  caption?: string;
}

/** Send a document from a text payload. Uses multipart/form-data. */
export async function sendDocument(
  token: string,
  opts: SendDocumentOpts,
): Promise<{ message_id: number }> {
  await acquireTelegramSlot({
    tokenTail: tokenTail(token),
    chatId: opts.chat_id,
  });
  const form = new FormData();
  form.append("chat_id", String(opts.chat_id));
  if (opts.caption) form.append("caption", opts.caption);
  const blob = new Blob([opts.content], {
    type: opts.mime ?? "text/markdown",
  });
  form.append("document", blob, opts.filename);
  const url = `${API_BASE}/bot${token}/sendDocument`;
  const res = await fetch(url, { method: "POST", body: form });
  const env = (await res.json()) as TgEnvelope<{ message_id: number }>;
  if (!env.ok) {
    throw new TelegramApiError(
      env.error_code ?? res.status,
      env.description ?? res.statusText,
      env.parameters?.retry_after ?? null,
    );
  }
  return env.result!;
}

export interface SetWebhookOpts {
  url: string;
  secret_token?: string;
  allowed_updates?: string[];
  drop_pending_updates?: boolean;
}

export async function setWebhook(
  token: string,
  opts: SetWebhookOpts,
): Promise<boolean> {
  return call<boolean>(
    token,
    "setWebhook",
    {
      url: opts.url,
      secret_token: opts.secret_token,
      allowed_updates: opts.allowed_updates ?? ["message"],
      drop_pending_updates: opts.drop_pending_updates ?? false,
    },
    { skipRateLimit: true },
  );
}

export async function deleteWebhook(
  token: string,
  dropPending = false,
): Promise<boolean> {
  return call<boolean>(
    token,
    "deleteWebhook",
    { drop_pending_updates: dropPending },
    { skipRateLimit: true },
  );
}
