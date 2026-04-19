/**
 * `ask_user` tool — lets the assistant pause mid-turn and ask the human a
 * multiple-choice question (optionally with a free-form "other" input). The
 * tool emits an `ask_user_question` SSE event with the question + options,
 * then blocks on a promise until the user submits an answer via
 * `POST /api/sessions/:sessionId/questions/:questionId/answer`.
 *
 * Closure-bound per run (same pattern as `call_agent`, `activate_skill`,
 * board/workspace/web tools). Each `runAgent` builds the handler via
 * {@link makeAskUserTool} and splices it into the per-run subset registry
 * only when the caller actually provides an interactive `emit` callback +
 * session id — non-interactive runs (CLI, board card runs, document/KB edit
 * handlers, subagent calls) never get the tool and the model can't hang on
 * it.
 */

import { randomUUID } from "node:crypto";
import type { JsonSchemaObject } from "../llm/types.ts";
import type { ToolHandler, ToolResult, ToolDescriptor } from "./registry.ts";
import type { SseAskUserQuestionEvent } from "../agent/sse_events.ts";
import { waitForAnswer } from "../agent/ask_user_registry.ts";

export const ASK_USER_TOOL_NAME = "ask_user";

export const ASK_USER_DESCRIPTION =
  "Pause the turn and ask the human a multiple-choice question. Prefer this over guessing whenever the right answer depends on the user's personal preference, context, or a constraint you don't have — e.g. 'help me choose between X and Y', 'which fits me best', or any prompt where you'd otherwise hedge with 'it depends'. Provide 2–5 short 'options' covering the realistic branches; the user can pick one, edit an option inline, or write their own answer. Returns the user's answer as a plain string — use it as the authoritative input for the rest of the turn. Do NOT use for trivia or purely informational questions you can answer directly.";

export const ASK_USER_SCHEMA: JsonSchemaObject = {
  type: "object",
  properties: {
    question: {
      type: "string",
      description: "The question to show the user. Keep it short and specific.",
    },
    options: {
      type: "array",
      description:
        "Suggested answers (0–6 items). The user can pick, edit, or ignore them. Leave empty for pure free-form input.",
      items: { type: "string" },
    },
    allow_custom: {
      type: "boolean",
      description:
        "Whether the UI should offer a free-form text input. Defaults to true.",
    },
    multi_select: {
      type: "boolean",
      description:
        "Whether the user may pick more than one option. Defaults to false.",
    },
  },
  required: ["question"],
};

const MAX_OPTIONS = 6;
const MAX_QUESTION_LEN = 2000;
const MAX_OPTION_LEN = 500;

export interface AskUserContext {
  sessionId: string;
  /** Author (agent name) to tag the SSE event with, so the UI can show it. */
  author?: string;
  /** Emit the question to the client. Typically wires to an SSE renderer. */
  emit(payload: SseAskUserQuestionEvent): void;
  /** Optional override for the answer timeout (ms). */
  timeoutMs?: number;
  /** Optional override for the questionId generator (testing). */
  newId?(): string;
}

export function makeAskUserTool(ctx: AskUserContext): ToolDescriptor {
  const handler: ToolHandler = async (args) => {
    const question =
      typeof args["question"] === "string" ? args["question"].trim() : "";
    if (!question) return errorResult("ask_user: 'question' is required");
    if (question.length > MAX_QUESTION_LEN) {
      return errorResult(
        `ask_user: question exceeds ${MAX_QUESTION_LEN} characters`,
      );
    }
    const rawOptions = Array.isArray(args["options"]) ? args["options"] : [];
    const options: string[] = [];
    for (const o of rawOptions) {
      if (typeof o !== "string") continue;
      const trimmed = o.trim();
      if (!trimmed) continue;
      if (trimmed.length > MAX_OPTION_LEN) {
        return errorResult(
          `ask_user: option exceeds ${MAX_OPTION_LEN} characters`,
        );
      }
      options.push(trimmed);
      if (options.length >= MAX_OPTIONS) break;
    }
    const allowCustom =
      args["allow_custom"] === undefined ? true : Boolean(args["allow_custom"]);
    const multiSelect = Boolean(args["multi_select"]);
    if (options.length === 0 && !allowCustom) {
      return errorResult(
        "ask_user: provide at least one option or set allow_custom=true",
      );
    }

    const questionId = (ctx.newId ?? randomUUID)();
    const payload: SseAskUserQuestionEvent = {
      type: "ask_user_question",
      questionId,
      question,
      options,
      allowCustom,
      multiSelect,
      ...(ctx.author ? { author: ctx.author } : {}),
    };
    try {
      ctx.emit(payload);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return errorResult(`ask_user: failed to emit question (${msg})`);
    }

    try {
      const answer = await waitForAnswer(
        ctx.sessionId,
        questionId,
        ctx.timeoutMs,
      );
      return {
        ok: true,
        output: answer,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return errorResult(msg);
    }
  };
  return {
    name: ASK_USER_TOOL_NAME,
    description: ASK_USER_DESCRIPTION,
    parameters: ASK_USER_SCHEMA,
    handler,
  };
}

function errorResult(msg: string): ToolResult {
  return { ok: false, output: msg, error: msg };
}
