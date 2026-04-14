/**
 * CLI renderer.
 *
 * Maps `StreamDelta` channels to ANSI colour codes and writes directly to
 * `process.stdout`. TTY-aware: colours and box-drawing characters are only
 * emitted when stdout is a real terminal (or when forced via config).
 *
 * Channel → colour mapping (all overridable in bunny.config.toml):
 *   content       → plain / no colour
 *   reasoning     → dim italic grey — inside a collapsible "╭─ thinking ─╮" block
 *   tool_call     → cyan
 *   tool_result   → green (ok) / red (error)
 *   error         → red bold
 *
 * Reasoning display modes (config render.reasoning):
 *   "collapsed"   → show block header, then dim text, collapse with footer once
 *                   content starts
 *   "inline"      → show reasoning text inline with a prefix on each line
 *   "hidden"      → suppress reasoning entirely
 *
 * In non-TTY mode (pipe / CI) ANSI codes are stripped and reasoning is either
 * prefixed with "[reasoning] " per line or omitted via --hide-reasoning.
 */

import type { StreamDelta } from "../llm/types.ts";
import type { ReasoningRenderMode } from "../config.ts";
import type { ToolResult } from "../tools/registry.ts";

// ---------------------------------------------------------------------------
// ANSI helpers

const ESC = "\x1b[";
const RESET = "\x1b[0m";

export const ANSI = {
  bold: (s: string) => `\x1b[1m${s}${RESET}`,
  dim: (s: string) => `\x1b[2m${s}${RESET}`,
  italic: (s: string) => `\x1b[3m${s}${RESET}`,
  dimItalic: (s: string) => `\x1b[2;3m${s}${RESET}`,
  cyan: (s: string) => `${ESC}36m${s}${RESET}`,
  green: (s: string) => `${ESC}32m${s}${RESET}`,
  red: (s: string) => `${ESC}31m${s}${RESET}`,
  grey: (s: string) => `${ESC}90m${s}${RESET}`,
  yellow: (s: string) => `${ESC}33m${s}${RESET}`,
} as const;

// ---------------------------------------------------------------------------
// Renderer

/**
 * Contract implemented by every renderer (CLI, SSE, tests). The agent loop
 * uses this shape and does not care about the underlying transport.
 */
export interface TurnStats {
  durationMs: number;
  promptTokens?: number;
  completionTokens?: number;
}

export interface Renderer {
  onDelta(delta: StreamDelta): void;
  onToolResult(name: string, result: ToolResult): void;
  onStats(stats: TurnStats): void;
  onError(message: string): void;
  onTurnEnd(): void;
}

export interface RendererOptions {
  reasoningMode: ReasoningRenderMode;
  /**
   * Force colour on or off. When undefined, TTY is auto-detected.
   */
  forceColor?: boolean;
  /**
   * Write destination. Defaults to `process.stdout`.
   */
  out?: { write(s: string): void };
}

export function createRenderer(opts: RendererOptions): Renderer {
  const color = opts.forceColor ?? process.stdout.isTTY ?? false;
  const out = opts.out ?? { write: (s: string) => process.stdout.write(s) };
  const mode = opts.reasoningMode;

  const fmt = {
    bold: (s: string) => (color ? ANSI.bold(s) : s),
    dim: (s: string) => (color ? ANSI.dim(s) : s),
    dimItalic: (s: string) => (color ? ANSI.dimItalic(s) : s),
    cyan: (s: string) => (color ? ANSI.cyan(s) : s),
    green: (s: string) => (color ? ANSI.green(s) : s),
    red: (s: string) => (color ? ANSI.red(s) : s),
    grey: (s: string) => (color ? ANSI.grey(s) : s),
  };

  // Track whether the reasoning block header has been printed.
  let reasoningBlockOpen = false;
  // Track whether we've started content (so we can close the reasoning block).
  let contentStarted = false;

  function openReasoningBlock(): void {
    if (reasoningBlockOpen) return;
    reasoningBlockOpen = true;
    if (mode === "collapsed" || mode === "inline") {
      out.write("\n" + fmt.grey(color ? "╭─ thinking ─────────────────────" : "[thinking]") + "\n");
    }
  }

  function closeReasoningBlock(): void {
    if (!reasoningBlockOpen) return;
    reasoningBlockOpen = false;
    if (mode === "collapsed") {
      out.write(fmt.grey(color ? "╰─────────────────────────────────" : "[/thinking]") + "\n\n");
    }
  }

  /** Handle a single `StreamDelta` from the LLM stream. */
  function onDelta(delta: StreamDelta): void {
    switch (delta.channel) {
      case "reasoning": {
        if (mode === "hidden") break;
        openReasoningBlock();
        if (mode === "inline") {
          // Prefix each line with a marker
          const lines = delta.text.split("\n");
          for (const line of lines) {
            out.write(fmt.dimItalic(line) + "\n");
          }
        } else {
          // collapsed: dim italic, no prefix
          out.write(fmt.dimItalic(delta.text));
        }
        break;
      }
      case "content": {
        if (!contentStarted) {
          contentStarted = true;
          closeReasoningBlock();
        }
        out.write(delta.text);
        break;
      }
      case "tool_call": {
        if (delta.name) {
          out.write("\n" + fmt.cyan(`⚙ ${delta.name}(`) + fmt.dim(delta.argsDelta));
        } else {
          out.write(fmt.dim(delta.argsDelta));
        }
        break;
      }
      case "usage":
        // Not rendered inline; consumers may log separately.
        break;
    }
  }

  /** Render the result of a tool call. */
  function onToolResult(name: string, result: ToolResult): void {
    const mark = result.ok ? fmt.green("✓") : fmt.red("✗");
    out.write(`) ${mark}\n`);
    if (!result.ok) {
      out.write(fmt.red(`  error: ${result.error ?? result.output}`) + "\n");
    }
  }

  /** Print a one-line stats footer: "⚡ 1.2s · 42 tok · 35 tok/s". */
  function onStats(stats: TurnStats): void {
    const secs = stats.durationMs / 1000;
    const tokPerSec =
      stats.completionTokens && stats.durationMs > 0
        ? ((stats.completionTokens / stats.durationMs) * 1000).toFixed(1)
        : null;
    const parts = [`${secs.toFixed(2)}s`];
    if (stats.completionTokens) parts.push(`${stats.completionTokens} tok`);
    if (tokPerSec) parts.push(`${tokPerSec} tok/s`);
    out.write(fmt.dim(`  ⚡ ${parts.join(" · ")}\n`));
  }

  /** Print an error message. */
  function onError(message: string): void {
    out.write("\n" + fmt.red(fmt.bold("error: ") + message) + "\n");
  }

  /** Called at the end of a full assistant turn. */
  function onTurnEnd(): void {
    // Ensure any open blocks are closed.
    closeReasoningBlock();
    // Ensure a trailing newline after the last content token.
    out.write("\n");
    // Reset state for the next turn.
    reasoningBlockOpen = false;
    contentStarted = false;
  }

  return { onDelta, onToolResult, onStats, onError, onTurnEnd };
}
