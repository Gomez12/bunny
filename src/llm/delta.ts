/**
 * Accumulates a stream of `StreamDelta` values into a final `LlmResponse`.
 *
 * Usage:
 *   const acc = new DeltaAccumulator();
 *   for await (const delta of stream) {
 *     acc.push(delta);
 *   }
 *   const response = acc.finish(startMs);
 */

import type { StreamDelta, LlmResponse, ToolCall } from "./types.ts";

interface PartialToolCall {
  id: string;
  name: string;
  argsBuf: string;
}

export class DeltaAccumulator {
  private _content = "";
  private _reasoning = "";
  private _toolCalls = new Map<number, PartialToolCall>();
  private _usage: LlmResponse["usage"];

  push(delta: StreamDelta): void {
    switch (delta.channel) {
      case "content":
        this._content += delta.text;
        break;
      case "reasoning":
        this._reasoning += delta.text;
        break;
      case "tool_call": {
        let tc = this._toolCalls.get(delta.callIndex);
        if (!tc) {
          tc = { id: "", name: "", argsBuf: "" };
          this._toolCalls.set(delta.callIndex, tc);
        }
        if (delta.id) tc.id = delta.id;
        if (delta.name) tc.name = delta.name;
        tc.argsBuf += delta.argsDelta;
        break;
      }
      case "usage":
        this._usage = {
          promptTokens: delta.promptTokens,
          completionTokens: delta.completionTokens,
          totalTokens: delta.totalTokens,
        };
        break;
    }
  }

  /**
   * Build the final `LlmResponse` after the stream is exhausted.
   * @param startMs - `Date.now()` when the first byte was received.
   */
  finish(startMs: number): LlmResponse {
    const toolCalls: ToolCall[] = [];
    for (const [, tc] of [...this._toolCalls].sort(([a], [b]) => a - b)) {
      toolCalls.push({
        id: tc.id || crypto.randomUUID(),
        type: "function",
        function: { name: tc.name, arguments: tc.argsBuf },
      });
    }

    return {
      message: {
        role: "assistant",
        content: this._content || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        ...(this._reasoning ? { reasoning: this._reasoning } : {}),
      },
      usage: this._usage,
      durationMs: Date.now() - startMs,
    };
  }

  /** Access the raw reasoning text (for streaming display). */
  get reasoningText(): string {
    return this._reasoning;
  }
}
