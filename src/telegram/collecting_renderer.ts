/**
 * Buffering Renderer for Telegram inbound turns.
 *
 * `runAgent` expects a Renderer that receives content/reasoning/tool deltas in
 * real time. Telegram has no streaming UI — we want just the final content
 * string once the turn finishes. This renderer concatenates content deltas
 * into `finalAnswer`; everything else is a no-op.
 *
 * Reasoning and tool events are intentionally dropped — the user sees them via
 * the web UI if they open the session, but the Telegram response is terse.
 */

import type { Renderer } from "../agent/render.ts";

export interface CollectingRenderer extends Renderer {
  /** Populated once the turn ends with the full assistant content. */
  getFinal(): string;
}

export function collectingRenderer(): CollectingRenderer {
  let buf = "";
  return {
    onDelta(delta) {
      if (delta.channel === "content") buf += delta.text;
    },
    onToolResult() {},
    onStats() {},
    onError() {},
    onTurnEnd() {},
    getFinal() {
      return buf;
    },
  };
}
