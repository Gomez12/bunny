/**
 * Inbound Telegram update dispatcher.
 *
 * Single entry point called from both the polling loop and the webhook route.
 * See ADR 0028 for the design; the short version:
 *
 *   1. Dedup via `markSeen` so a re-delivered update doesn't cause a double
 *      response.
 *   2. Advance `last_update_id` BEFORE processing (poison-message safety).
 *   3. Handle bot-commands (`/start <token>`, `/new`, `/reset`, `/help`).
 *   4. Resolve `chat_id → user_id` via `user_telegram_links`. Unknown chat
 *      gets a canned "please link your account" reply.
 *   5. Acquire per-chat mutex — serialisation prevents two parallel
 *      `runAgent` calls racing the same session.
 *   6. Resolve (or create) the rolling `current_session_id`.
 *   7. Call `runAgent` with `askUserEnabled: false` (no UI for questions) and
 *      `mentionsEnabled: true` (a Telegram user may legitimately @-mention
 *      a Bunny user).
 *   8. Render the final answer to HTML, chunk, and send.
 *   9. Release mutex.
 *
 * Non-text/media/group updates log `message.inbound.unsupported` and reply
 * with a friendly notice. v1 is DM-text only.
 */

import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { BunnyConfig } from "../config.ts";
import type { BunnyQueue } from "../queue/bunqueue.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import { runAgent } from "../agent/loop.ts";
import { errorMessage } from "../util/error.ts";
import {
  advanceLastUpdateId,
  getTelegramConfig,
} from "../memory/telegram_config.ts";
import {
  getLinkByChatId,
  releaseMutex,
  setCurrentSession,
  tryAcquireMutex,
} from "../memory/telegram_links.ts";
import { markSeen } from "../memory/telegram_seen.ts";
import { sendMessage, sendDocument, TelegramApiError } from "./client.ts";
import { decideFormat } from "./format.ts";
import { consumePendingLink } from "./linking.ts";
import { collectingRenderer } from "./collecting_renderer.ts";
import { escapeTelegramHtml, tokenTail } from "./util.ts";
import type { TgUpdate, TgMessage } from "./types.ts";

const MUTEX_TTL_MS = 5 * 60 * 1000;

const CANNED_UNLINKED = [
  "👋 Hi! This Telegram chat isn't linked to a Bunny account yet.",
  "Open Bunny → Settings → <b>Telegram</b> to generate a one-time link token,",
  "then send it to this bot as <code>/start &lt;token&gt;</code>.",
].join("\n");

const CANNED_UNSUPPORTED = [
  "Sorry, I can only handle plain text messages right now. Attachments,",
  "voice notes, photos, stickers, and group chats aren't supported yet.",
].join("\n");

const CANNED_BUSY =
  "⏳ Still processing your previous message — hang on a second.";

const CANNED_HELP = [
  "<b>Available commands</b>",
  "• <code>/start &lt;token&gt;</code> — link this chat to a Bunny account",
  "• <code>/new</code> — start a fresh conversation",
  "• <code>/reset</code> — same as /new",
  "• <code>/help</code> — show this message",
  "",
  "Any other message is forwarded to the project's agent.",
].join("\n");

export interface HandleUpdateOpts {
  db: Database;
  queue: BunnyQueue;
  cfg: BunnyConfig;
  tools: ToolRegistry;
  project: string;
  update: TgUpdate;
  now?: number;
}

export async function handleTelegramUpdate(
  opts: HandleUpdateOpts,
): Promise<void> {
  const { db, queue, cfg, tools, project, update } = opts;
  const now = opts.now ?? Date.now();

  // Dedup BEFORE anything so a retry costs one insert and nothing else.
  const fresh = markSeen(db, project, update.update_id, now);
  if (!fresh) return;

  // Poison-message safety: advance last_update_id before processing.
  advanceLastUpdateId(db, project, update.update_id);

  const tgCfg = getTelegramConfig(db, project);
  if (!tgCfg || !tgCfg.enabled) {
    void queue.log({
      topic: "telegram",
      kind: "message.inbound.dropped",
      data: { project, reason: "disabled", updateId: update.update_id },
    });
    return;
  }

  // v1: handle `message` only. Edits / channel posts / callback queries are
  // logged for visibility but otherwise ignored.
  const message = update.message;
  if (!message) {
    void queue.log({
      topic: "telegram",
      kind: "message.inbound.unsupported",
      data: {
        project,
        updateId: update.update_id,
        kind: unsupportedKind(update),
      },
    });
    return;
  }

  if (message.chat.type !== "private") {
    await replyToMessage(tgCfg.botToken, message, CANNED_UNSUPPORTED, queue, project);
    void queue.log({
      topic: "telegram",
      kind: "message.inbound.unsupported",
      data: {
        project,
        updateId: update.update_id,
        chatType: message.chat.type,
      },
    });
    return;
  }

  const text = (message.text ?? message.caption ?? "").trim();
  if (!text) {
    await replyToMessage(tgCfg.botToken, message, CANNED_UNSUPPORTED, queue, project);
    void queue.log({
      topic: "telegram",
      kind: "message.inbound.unsupported",
      data: { project, updateId: update.update_id, reason: "empty_or_media" },
    });
    return;
  }

  // Slash commands.
  if (text.startsWith("/")) {
    const handled = await handleSlashCommand({
      db,
      queue,
      token: tgCfg.botToken,
      project,
      message,
      text,
      now,
    });
    if (handled) return;
  }

  // Non-command: require a link.
  const link = getLinkByChatId(db, project, message.chat.id);
  if (!link) {
    await replyToMessage(tgCfg.botToken, message, CANNED_UNLINKED, queue, project);
    void queue.log({
      topic: "telegram",
      kind: "message.inbound.unlinked",
      data: {
        project,
        updateId: update.update_id,
        chatId: message.chat.id,
        tgUsername: message.from?.username ?? null,
      },
    });
    return;
  }

  // Serialise per chat. On contention, reply "busy" and drop — the user can
  // resend once the previous turn finishes.
  if (!tryAcquireMutex(db, project, message.chat.id, MUTEX_TTL_MS, now)) {
    await replyToMessage(tgCfg.botToken, message, CANNED_BUSY, queue, project);
    void queue.log({
      topic: "telegram",
      kind: "message.inbound.busy",
      userId: link.userId,
      data: { project, updateId: update.update_id, chatId: message.chat.id },
    });
    return;
  }

  const sessionId = link.currentSessionId ?? randomUUID();
  if (!link.currentSessionId) {
    setCurrentSession(db, project, message.chat.id, sessionId);
  }

  void queue.log({
    topic: "telegram",
    kind: "message.inbound",
    userId: link.userId,
    sessionId,
    data: {
      project,
      updateId: update.update_id,
      chatId: message.chat.id,
      tokenTail: tokenTail(tgCfg.botToken),
    },
  });

  const renderer = collectingRenderer();
  try {
    await runAgent({
      prompt: text,
      sessionId,
      userId: link.userId,
      project,
      llmCfg: cfg.llm,
      embedCfg: cfg.embed,
      memoryCfg: cfg.memory,
      agentCfg: cfg.agent,
      webCfg: cfg.web,
      tools,
      db,
      queue,
      renderer,
      // No UI to surface ask_user cards. Mentions are fine — Telegram users
      // may legit ping Bunny users from chat.
      askUserEnabled: false,
      mentionsEnabled: true,
    });
    const final = renderer.getFinal().trim();
    if (final) {
      await sendFinalAnswer(tgCfg.botToken, message.chat.id, final, cfg);
    } else {
      await replyToMessage(
        tgCfg.botToken,
        message,
        "(no response from the agent)",
        queue,
        project,
      );
    }
  } catch (err) {
    const msg = errorMessage(err);
    await replyToMessage(
      tgCfg.botToken,
      message,
      `⚠️ Something went wrong: ${msg}`,
      queue,
      project,
    );
    void queue.log({
      topic: "telegram",
      kind: "error",
      userId: link.userId,
      sessionId,
      data: {
        stage: "runAgent",
        project,
        updateId: update.update_id,
        chatId: message.chat.id,
      },
      error: msg,
    });
  } finally {
    releaseMutex(db, project, message.chat.id);
  }
}

interface SlashCommandOpts {
  db: Database;
  queue: BunnyQueue;
  token: string;
  project: string;
  message: TgMessage;
  text: string;
  now: number;
}

async function handleSlashCommand(opts: SlashCommandOpts): Promise<boolean> {
  const { db, queue, token, project, message, text, now } = opts;
  // Telegram puts `/cmd@botname` in the text when the chat is a group. v1 is
  // DM-only, but strip the suffix anyway so /start@foo is accepted.
  const firstWord = text.split(/\s+/)[0] ?? "";
  const command = firstWord.split("@")[0] ?? "";
  const rest = text.slice(firstWord.length).trim();

  if (command === "/help") {
    await replyToMessage(token, message, CANNED_HELP, queue, project);
    return true;
  }

  if (command === "/start") {
    const token_ = rest.trim();
    if (!token_) {
      await replyToMessage(token, message, CANNED_UNLINKED, queue, project);
      void queue.log({
        topic: "telegram",
        kind: "link.create.failed",
        data: {
          project,
          chatId: message.chat.id,
          reason: "no_token",
        },
      });
      return true;
    }
    const outcome = consumePendingLink(db, {
      project,
      chatId: message.chat.id,
      token: token_,
      tgUsername: message.from?.username ?? null,
      now,
    });
    if (outcome.kind === "expired_or_invalid") {
      await replyToMessage(
        token,
        message,
        "❌ That link token is invalid or has expired. Generate a fresh one from Bunny → Settings → Telegram.",
        queue,
        project,
      );
      void queue.log({
        topic: "telegram",
        kind: "link.create.failed",
        data: {
          project,
          chatId: message.chat.id,
          reason: "expired_or_invalid",
        },
      });
      return true;
    }
    if (outcome.kind === "wrong_project") {
      await replyToMessage(
        token,
        message,
        `❌ That token was generated for project <b>${escapeTelegramHtml(outcome.expected)}</b>, but this bot is in project <b>${escapeTelegramHtml(outcome.got)}</b>. Generate a new token from the correct project.`,
        queue,
        project,
      );
      void queue.log({
        topic: "telegram",
        kind: "link.create.failed",
        data: {
          project,
          chatId: message.chat.id,
          reason: "wrong_project",
          expected: outcome.expected,
        },
      });
      return true;
    }
    await replyToMessage(
      token,
      message,
      `✅ Linked! You're now chatting as <b>${escapeTelegramHtml(outcome.link.userId)}</b> in project <b>${escapeTelegramHtml(project)}</b>. Send anything to talk to the agent, or <code>/help</code> for commands.`,
      queue,
      project,
    );
    void queue.log({
      topic: "telegram",
      kind: "link.create.confirm",
      userId: outcome.link.userId,
      data: {
        project,
        chatId: message.chat.id,
        tgUsername: message.from?.username ?? null,
      },
    });
    return true;
  }

  if (command === "/new" || command === "/reset") {
    const link = getLinkByChatId(db, project, message.chat.id);
    if (!link) {
      await replyToMessage(token, message, CANNED_UNLINKED, queue, project);
      return true;
    }
    setCurrentSession(db, project, message.chat.id, null);
    await replyToMessage(
      token,
      message,
      "🧹 Conversation cleared — your next message starts a fresh session.",
      queue,
      project,
    );
    void queue.log({
      topic: "telegram",
      kind: "session.reset",
      userId: link.userId,
      data: { project, chatId: message.chat.id },
    });
    return true;
  }

  // Unknown slash command — fall through to the normal agent flow so the
  // agent can be prompted with it verbatim.
  return false;
}

async function replyToMessage(
  token: string,
  message: TgMessage,
  html: string,
  queue?: BunnyQueue,
  project?: string,
): Promise<void> {
  try {
    await sendMessage(token, {
      chat_id: message.chat.id,
      text: html,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_to_message_id: message.message_id,
    });
  } catch (err) {
    // Canned replies use this path (unlinked chat, unsupported update, slash
    // commands). A failure here means Telegram is unreachable for this chat —
    // nothing to do but log so admins can see it in the Logs tab.
    if (queue) {
      void queue.log({
        topic: "telegram",
        kind: "error",
        data: { stage: "canned_reply", project, chatId: message.chat.id },
        error: errorMessage(err),
      });
    }
  }
}

async function sendFinalAnswer(
  token: string,
  chatId: number,
  raw: string,
  cfg: BunnyConfig,
): Promise<void> {
  const decision = decideFormat(raw, {
    documentFallbackSize: cfg.telegram.documentFallbackBytes,
    maxChunkChars: cfg.telegram.chunkChars,
  });
  if (decision.mode === "document") {
    await sendDocument(token, {
      chat_id: chatId,
      filename: decision.filename ?? "bunny-reply.md",
      content: decision.chunks[0] ?? "",
      caption: "Response was long — sent as a file.",
    });
    return;
  }
  for (const chunk of decision.chunks) {
    try {
      await sendMessage(token, {
        chat_id: chatId,
        text: chunk,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
    } catch (err) {
      if (err instanceof TelegramApiError && err.code === 400) {
        // Malformed HTML — retry with plain text.
        await sendMessage(token, {
          chat_id: chatId,
          text: stripHtml(chunk),
          disable_web_page_preview: true,
        });
      } else {
        throw err;
      }
    }
  }
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function unsupportedKind(update: TgUpdate): string {
  if (update.edited_message) return "edited_message";
  if (update.channel_post) return "channel_post";
  if (update.edited_channel_post) return "edited_channel_post";
  if (update.callback_query) return "callback_query";
  if (update.my_chat_member) return "my_chat_member";
  return "unknown";
}
