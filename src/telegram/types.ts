/**
 * Telegram Bot API subset we care about.
 *
 * Typed minimally — only the fields the integration actually reads. Keeping
 * this narrow means we don't need to babysit Telegram's occasional schema
 * churn in optional fields we ignore.
 */

export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface TgChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
  entities?: Array<{ type: string; offset: number; length: number }>;
  caption?: string;
  photo?: unknown;
  document?: unknown;
  voice?: unknown;
  video?: unknown;
  audio?: unknown;
  sticker?: unknown;
  reply_to_message?: TgMessage;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  channel_post?: TgMessage;
  edited_channel_post?: TgMessage;
  callback_query?: unknown;
  my_chat_member?: unknown;
}

export interface TgMeResponse {
  id: number;
  is_bot: boolean;
  username: string;
  first_name?: string;
  can_join_groups?: boolean;
  can_read_all_group_messages?: boolean;
}
