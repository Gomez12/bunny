/**
 * SSE renderer — serialises agent events as JSON payloads pushed through a
 * `ReadableStreamDefaultController<Uint8Array>`. The frontend consumes them
 * via `fetch` + a streaming body reader. Event shapes live in `sse_events.ts`
 * so backend and frontend stay in sync via a shared type.
 */

import type { StreamDelta } from "../llm/types.ts";
import type { ToolResult } from "../tools/registry.ts";
import type { Renderer } from "./render.ts";
import type { SseEvent } from "./sse_events.ts";

const encoder = new TextEncoder();

export interface SseSink {
  enqueue(chunk: Uint8Array): void;
  close(): void;
}

/**
 * Adapts any `ReadableStreamDefaultController<Uint8Array>` to a plain sink.
 * Ignores errors raised when the stream has already been closed (e.g. client
 * disconnect) so renderer callbacks never throw back into the agent loop.
 */
export function controllerSink(
  controller: ReadableStreamDefaultController<Uint8Array>,
): SseSink {
  let closed = false;
  return {
    enqueue(chunk) {
      if (closed) return;
      try {
        controller.enqueue(chunk);
      } catch {
        closed = true;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        controller.close();
      } catch {
        /* already closed */
      }
    },
  };
}

function send(sink: SseSink, payload: SseEvent): void {
  sink.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
}

export interface SseRendererOpts {
  /** Tag every emitted event with this agent name so the UI can show it. */
  author?: string;
}

export function createSseRenderer(
  sink: SseSink,
  opts: SseRendererOpts = {},
): Renderer {
  const author = opts.author;
  const tag = <T extends object>(payload: T): T & { author?: string } =>
    author ? { ...payload, author } : payload;

  function onDelta(delta: StreamDelta): void {
    switch (delta.channel) {
      case "content":
        send(sink, tag({ type: "content", text: delta.text }));
        break;
      case "reasoning":
        send(sink, tag({ type: "reasoning", text: delta.text }));
        break;
      case "tool_call":
        send(
          sink,
          tag({
            type: "tool_call",
            name: delta.name,
            id: delta.id,
            argsDelta: delta.argsDelta,
            callIndex: delta.callIndex,
          }),
        );
        break;
      case "usage":
        send(sink, {
          type: "usage",
          promptTokens: delta.promptTokens,
          completionTokens: delta.completionTokens,
          totalTokens: delta.totalTokens,
        });
        break;
    }
  }

  function onToolResult(name: string, result: ToolResult): void {
    send(
      sink,
      tag({
        type: "tool_result",
        name,
        ok: result.ok,
        output: result.output,
        error: result.error,
      }),
    );
  }

  function onStats(stats: {
    durationMs: number;
    promptTokens?: number;
    completionTokens?: number;
  }): void {
    send(sink, {
      type: "stats",
      durationMs: stats.durationMs,
      promptTokens: stats.promptTokens,
      completionTokens: stats.completionTokens,
    });
  }

  function onError(message: string): void {
    send(sink, { type: "error", message });
  }

  function onTurnEnd(): void {
    send(sink, tag({ type: "turn_end" }));
  }

  function onAskUserQuestion(ev: {
    type: "ask_user_question";
    questionId: string;
    question: string;
    options: string[];
    allowCustom: boolean;
    multiSelect: boolean;
  }): void {
    send(sink, tag(ev));
  }

  function onQueueWait(ev: { position: number }): void {
    send(sink, {
      type: "llm_queue_wait",
      position: ev.position,
      since: Date.now(),
    });
  }

  function onQueueRelease(ev: { waitedMs: number }): void {
    send(sink, { type: "llm_queue_release", waitedMs: ev.waitedMs });
  }

  return {
    onDelta,
    onToolResult,
    onStats,
    onError,
    onTurnEnd,
    onAskUserQuestion,
    onQueueWait,
    onQueueRelease,
  };
}

/** Emit the terminal `done` event and close the underlying stream. */
export function finishSse(sink: SseSink): void {
  send(sink, { type: "done" });
  sink.close();
}
