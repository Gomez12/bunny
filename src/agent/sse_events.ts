/**
 * Shared type contract for SSE events emitted by the agent and consumed by
 * the web UI. Imported by both `src/agent/render_sse.ts` (backend) and
 * `web/src/api.ts` (frontend) so adding a new event type is a compile error
 * on both sides instead of silent drift.
 *
 * Wire format: each event is one `data: {json}\n\n` frame.
 */

export interface SseContentEvent {
  type: "content";
  text: string;
  /** Responding agent name. Absent for the default assistant. */
  author?: string;
}

export interface SseReasoningEvent {
  type: "reasoning";
  text: string;
  author?: string;
}

export interface SseToolCallEvent {
  type: "tool_call";
  name?: string;
  id?: string;
  argsDelta: string;
  callIndex: number;
  author?: string;
}

export interface SseToolResultEvent {
  type: "tool_result";
  name: string;
  ok: boolean;
  output: string;
  error?: string;
  author?: string;
}

export interface SseUsageEvent {
  type: "usage";
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface SseStatsEvent {
  type: "stats";
  durationMs: number;
  promptTokens?: number;
  completionTokens?: number;
}

export interface SseErrorEvent {
  type: "error";
  message: string;
}

export interface SseTurnEndEvent {
  type: "turn_end";
  author?: string;
}

export interface SseDoneEvent {
  type: "done";
}

/** Emitted by the board card-run orchestrator the moment the agent kicks off. */
export interface SseCardRunStartedEvent {
  type: "card_run_started";
  cardId: number;
  runId: number;
  sessionId: string;
}

/** Emitted when the run finishes (success or error). Mirrors what was written
 * to `board_card_runs` so a late SSE subscriber can rebuild the final state. */
export interface SseCardRunFinishedEvent {
  type: "card_run_finished";
  cardId: number;
  runId: number;
  status: "done" | "error";
  finalAnswer?: string;
  error?: string;
}

/** Emitted by the KB /generate handler once the model's JSON has been parsed
 * and persisted. Tells the client the stored row is up to date. */
export interface SseKbDefinitionGeneratedEvent {
  type: "kb_definition_generated";
  definitionId: number;
  sources: number;
}

/** Emitted by the KB /generate-illustration handler once the model's SVG has
 * been parsed and persisted. `bytes` is the UTF-8 byte length of the stored
 * SVG markup — useful for a "size saved" indicator. */
export interface SseKbDefinitionIllustrationGeneratedEvent {
  type: "kb_definition_illustration_generated";
  definitionId: number;
  bytes: number;
}

/** Emitted when a translation sidecar row reaches a terminal state (ready or
 * error) inside a session-scoped SSE stream. Only fires when the translation
 * ran inside an active user session — background scheduler ticks have no
 * project-room broadcast primitive, so the frontend relies on polling. */
export interface SseTranslationGeneratedEvent {
  type: "translation_generated";
  kind: "kb_definition" | "document" | "contact" | "board_card";
  entityId: number;
  lang: string;
  status: "ready" | "error";
  error?: string;
}

/** Emitted when a Web News topic run finishes. Reserved for a future
 * project-scoped SSE stream — the v1 frontend polls instead. */
export interface SseWebNewsRunFinishedEvent {
  type: "web_news_run_finished";
  topicId: number;
  project: string;
  status: "ok" | "error";
  inserted?: number;
  duplicates?: number;
  error?: string;
}

/** Emitted when a Web News topic transitions between idle / running / error.
 * Reserved — v1 frontend polls. */
export interface SseWebNewsTopicStatusEvent {
  type: "web_news_topic_status";
  topicId: number;
  project: string;
  status: "idle" | "running" | "error";
}

/** Emitted by the `ask_user` tool. The handler blocks until the user submits an
 * answer via `POST /api/sessions/:sessionId/questions/:questionId/answer`, then
 * the answer is returned as the tool result. */
export interface SseAskUserQuestionEvent {
  type: "ask_user_question";
  /** Unique id — used as the path segment when posting the answer. */
  questionId: string;
  question: string;
  /** Suggested answers. Empty when the model wants free-form input only. */
  options: string[];
  /** Whether the UI should offer a free-form text input in addition to the
   *  options (or on its own when `options` is empty). */
  allowCustom: boolean;
  /** Whether the user may pick more than one option. */
  multiSelect: boolean;
  author?: string;
}

/** Serialisable notification row shipped to the web UI. Matches the shape
 *  returned from `GET /api/notifications` and embedded in
 *  `SseNotificationCreatedEvent` so front-end and back-end stay in lock-step. */
export interface NotificationDto {
  id: number;
  kind: "mention" | "mention_blocked" | string;
  title: string;
  body: string;
  actorUserId: string | null;
  actorUsername: string | null;
  actorDisplayName: string | null;
  project: string | null;
  sessionId: string | null;
  messageId: number | null;
  deepLink: string;
  readAt: number | null;
  createdAt: number;
}

/** Emitted into the recipient's per-user fanout when a new notification
 *  row is created (e.g. by the chat mention dispatcher). */
export interface SseNotificationCreatedEvent {
  type: "notification_created";
  notification: NotificationDto;
}

/** Emitted into the user's own fanout when a notification is marked read,
 *  so other tabs can decrement their unread badge immediately. `ids: []`
 *  means "every unread row was just marked read" (mark-all-read). */
export interface SseNotificationReadEvent {
  type: "notification_read";
  ids: number[];
  readAt: number;
}

export type SseEvent =
  | SseContentEvent
  | SseReasoningEvent
  | SseToolCallEvent
  | SseToolResultEvent
  | SseUsageEvent
  | SseStatsEvent
  | SseErrorEvent
  | SseTurnEndEvent
  | SseDoneEvent
  | SseCardRunStartedEvent
  | SseCardRunFinishedEvent
  | SseKbDefinitionGeneratedEvent
  | SseKbDefinitionIllustrationGeneratedEvent
  | SseTranslationGeneratedEvent
  | SseWebNewsRunFinishedEvent
  | SseWebNewsTopicStatusEvent
  | SseAskUserQuestionEvent
  | SseNotificationCreatedEvent
  | SseNotificationReadEvent;
